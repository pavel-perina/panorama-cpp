#pragma once
// SDF font renderer: loads the PSDF atlas baked by scripts/bake_font_sdf.py
// and draws UTF-8 text into raw interleaved images. Distance-field sampling
// keeps glyph edges crisp under rotation and scaling — the 45° summit
// labels — with no text-rendering library at runtime.

#include <cstdint>
#include <filesystem>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace pano {

class SdfFont {
public:
    // Throws std::runtime_error on a missing or malformed atlas file.
    static SdfFont load(const std::filesystem::path &path);

    // Advance width of the string at sizePx (plain advances, no kerning —
    // matching the bake, which stores none).
    double textWidth(std::string_view utf8, double sizePx) const;

    // Draws text into an interleaved image (`channels` bytes per pixel),
    // blending color[0..channels) by SDF coverage. (x, y) is the baseline
    // start; angleDeg rotates counterclockwise around it. Subpixel
    // (ClearType-like) coverage is deliberately absent: labels get scaled
    // (web zoom) and printed, where RGB fringes turn into color noise —
    // revisit as an opt-in for the desktop app at final resolution.
    void drawText(uint8_t *image, int imgWidth, int imgHeight, int channels,
                  std::string_view utf8, double x, double y,
                  double sizePx, double angleDeg, const uint8_t *color) const;

    double lineHeight(double sizePx) const { return m_lineHeight * sizePx / m_emPx; }
    double ascender(double sizePx) const { return m_ascender * sizePx / m_emPx; }

private:
    struct Glyph {
        uint16_t x, y, w, h;               // atlas rect (spread padding baked in)
        float bearingX, bearingY, advance; // px at m_emPx scale
    };

    float m_emPx = 0, m_spreadPx = 0;
    float m_ascender = 0, m_descender = 0, m_lineHeight = 0;
    uint32_t m_atlasW = 0, m_atlasH = 0;
    std::vector<uint8_t> m_atlas; // row-major, 128 = glyph edge
    std::unordered_map<uint32_t, Glyph> m_glyphs;
};

} // namespace pano
