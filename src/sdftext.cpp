#include "sdftext.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <format>
#include <fstream>
#include <stdexcept>

#include "geo.hpp" // kPi, toRadians

namespace pano {

namespace {

static_assert(std::endian::native == std::endian::little,
              "PSDF parsing assumes a little-endian host (x86-64 and WASM are)");

template <typename T>
T readAs(const uint8_t *&p)
{
    T value;
    std::memcpy(&value, p, sizeof value);
    p += sizeof value;
    return value;
}

// Minimal UTF-8 decoder; malformed input yields garbage codepoints, which
// simply miss the glyph table (peak names come from our own TSVs).
uint32_t nextCodepoint(std::string_view s, size_t &i)
{
    const uint8_t first = uint8_t(s[i++]);
    if (first < 0x80)
        return first;
    const int extra = first >= 0xF0 ? 3 : first >= 0xE0 ? 2 : 1;
    uint32_t cp = first & (0x3F >> extra);
    for (int k = 0; k < extra && i < s.size(); ++k)
        cp = (cp << 6) | (uint8_t(s[i++]) & 0x3F);
    return cp;
}

} // namespace

SdfFont SdfFont::load(const std::filesystem::path &path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Cannot open font atlas " + path.string() +
                                 " (run scripts/bake_font_sdf.py)");
    const std::vector<uint8_t> data(std::istreambuf_iterator<char>(file), {});

    SdfFont font;
    const uint8_t *p = data.data();
    if (data.size() < 40 || std::memcmp(p, "PSDF", 4) != 0)
        throw std::runtime_error(path.string() + ": not a PSDF atlas");
    p += 4;
    const uint32_t version = readAs<uint32_t>(p);
    font.m_atlasW = readAs<uint32_t>(p);
    font.m_atlasH = readAs<uint32_t>(p);
    const uint32_t glyphCount = readAs<uint32_t>(p);
    font.m_emPx = readAs<float>(p);
    font.m_spreadPx = readAs<float>(p);
    font.m_ascender = readAs<float>(p);
    font.m_descender = readAs<float>(p);
    font.m_lineHeight = readAs<float>(p);
    const size_t expected = 40 + size_t(glyphCount) * 24 +
                            size_t(font.m_atlasW) * font.m_atlasH;
    if (version != 1 || data.size() != expected)
        throw std::runtime_error(std::format("{}: PSDF version {} / size {} (expected {})",
                                             path.string(), version, data.size(), expected));

    font.m_glyphs.reserve(glyphCount);
    for (uint32_t i = 0; i < glyphCount; ++i) {
        const uint32_t cp = readAs<uint32_t>(p);
        Glyph g;
        g.x = readAs<uint16_t>(p);
        g.y = readAs<uint16_t>(p);
        g.w = readAs<uint16_t>(p);
        g.h = readAs<uint16_t>(p);
        g.bearingX = readAs<float>(p);
        g.bearingY = readAs<float>(p);
        g.advance = readAs<float>(p);
        font.m_glyphs.emplace(cp, g);
    }
    font.m_atlas.assign(p, p + size_t(font.m_atlasW) * font.m_atlasH);
    return font;
}

double SdfFont::textWidth(std::string_view utf8, double sizePx) const
{
    double advance = 0.0;
    for (size_t i = 0; i < utf8.size();) {
        const auto it = m_glyphs.find(nextCodepoint(utf8, i));
        if (it != m_glyphs.end())
            advance += it->second.advance;
    }
    return advance * sizePx / m_emPx;
}

void SdfFont::drawText(uint8_t *image, int imgWidth, int imgHeight, int channels,
                       std::string_view utf8, double x, double y,
                       double sizePx, double angleDeg, const uint8_t *color,
                       const uint8_t *outlineColor, double outlinePx) const
{
    constexpr double kAaWidthPx = 1.0; // coverage ramp width on screen
    const double s = sizePx / m_emPx;
    // The atlas only stores distances up to spreadPx from the edge; a wider
    // outline would clip to a square at the glyph padding boundary.
    if (outlineColor)
        outlinePx = std::min(outlinePx, m_spreadPx * s - kAaWidthPx);
    const double a = toRadians(angleDeg);
    // baseline / "down" direction in screen coords (y down, angle CCW)
    const double dirX = std::cos(a), dirY = -std::sin(a);
    const double dwnX = -dirY, dwnY = dirX;

    double penX = x, penY = y;
    for (size_t i = 0; i < utf8.size();) {
        const auto it = m_glyphs.find(nextCodepoint(utf8, i));
        if (it == m_glyphs.end())
            continue;
        const Glyph &g = it->second;
        if (g.w == 0 || g.h == 0) {
            penX += g.advance * s * dirX;
            penY += g.advance * s * dirY;
            continue;
        }
        // Screen bounding box of the rotated glyph quad.
        double minX = 1e30, minY = 1e30, maxX = -1e30, maxY = -1e30;
        for (const auto &[u, v] : {std::pair{0, 0}, {g.w, 0}, {0, g.h}, {g.w, g.h}}) {
            const double lx = (g.bearingX + u) * s;
            const double ly = (v - g.bearingY) * s;
            const double px = penX + lx * dirX + ly * dwnX;
            const double py = penY + lx * dirY + ly * dwnY;
            minX = std::min(minX, px), maxX = std::max(maxX, px);
            minY = std::min(minY, py), maxY = std::max(maxY, py);
        }
        const int x0 = std::max(int(minX) - 1, 0), x1 = std::min(int(maxX) + 2, imgWidth);
        const int y0 = std::max(int(minY) - 1, 0), y1 = std::min(int(maxY) + 2, imgHeight);

        for (int py = y0; py < y1; ++py) {
            for (int px = x0; px < x1; ++px) {
                // inverse transform: screen -> glyph-local -> atlas coords
                const double rx = px - penX, ry = py - penY;
                const double u = (rx * dirX + ry * dirY) / s - g.bearingX;
                const double v = (rx * dwnX + ry * dwnY) / s + g.bearingY;
                if (u < 0.0 || u >= g.w - 1.0 || v < 0.0 || v >= g.h - 1.0)
                    continue;
                const int iu = int(u), iv = int(v);
                const double fu = u - iu, fv = v - iv;
                const uint8_t *row = &m_atlas[size_t(g.y + iv) * m_atlasW + g.x + iu];
                const double value =
                    row[0] * (1 - fu) * (1 - fv) + row[1] * fu * (1 - fv) +
                    row[m_atlasW] * (1 - fu) * fv + row[m_atlasW + 1] * fu * fv;
                const double distScreen = (value - 128.0) * (m_spreadPx / 127.0) * s;
                const double alpha = std::clamp(distScreen / kAaWidthPx + 0.5, 0.0, 1.0);
                uint8_t *pixel = &image[(size_t(py) * imgWidth + px) * channels];
                if (outlineColor) {
                    // coverage of the glyph dilated by outlinePx: halo under
                    // the fill, so the band outside the edge survives
                    const double haloAlpha = std::clamp(
                        (distScreen + outlinePx) / kAaWidthPx + 0.5, 0.0, 1.0);
                    if (haloAlpha <= 0.0)
                        continue;
                    for (int ch = 0; ch < channels; ++ch)
                        pixel[ch] = uint8_t(pixel[ch] + (outlineColor[ch] - pixel[ch]) * haloAlpha + 0.5);
                } else if (alpha <= 0.0) {
                    continue;
                }
                for (int ch = 0; ch < channels; ++ch)
                    pixel[ch] = uint8_t(pixel[ch] + (color[ch] - pixel[ch]) * alpha + 0.5);
            }
        }
        penX += g.advance * s * dirX;
        penY += g.advance * s * dirY;
    }
}

} // namespace pano
