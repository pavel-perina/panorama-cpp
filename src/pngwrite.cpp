#include "pngwrite.hpp"

#include <algorithm>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <vector>

#include <zlib.h>

namespace pano {

namespace {

void appendBigEndian32(std::vector<uint8_t> &out, uint32_t value)
{
    out.push_back(uint8_t(value >> 24));
    out.push_back(uint8_t(value >> 16));
    out.push_back(uint8_t(value >> 8));
    out.push_back(uint8_t(value));
}

void writeChunk(std::ofstream &out, const char type[4],
                const uint8_t *data, size_t size)
{
    std::vector<uint8_t> head;
    appendBigEndian32(head, uint32_t(size));
    head.insert(head.end(), type, type + 4);
    out.write(reinterpret_cast<const char *>(head.data()), std::streamsize(head.size()));
    if (size)
        out.write(reinterpret_cast<const char *>(data), std::streamsize(size));
    uint32_t crc = uint32_t(crc32(0, reinterpret_cast<const Bytef *>(type), 4));
    if (size)
        crc = uint32_t(crc32(crc, data, uInt(size)));
    std::vector<uint8_t> tail;
    appendBigEndian32(tail, crc);
    out.write(reinterpret_cast<const char *>(tail.data()), 4);
}

} // namespace

void writePng(const std::filesystem::path &path, int width, int height,
              int channels, int bitDepth, const void *data)
{
    if ((channels != 1 && channels != 3) || (bitDepth != 8 && bitDepth != 16))
        throw std::runtime_error("writePng: unsupported format");

    const size_t rowBytes = size_t(width) * channels * (bitDepth / 8);
    const uint8_t *src = static_cast<const uint8_t *>(data);

    // Filtered scanlines: one filter byte + row, "Up" (2) throughout — the
    // per-line vertical delta; byte-wise, so identical for every format.
    std::vector<uint8_t> raw((rowBytes + 1) * size_t(height));
    std::vector<uint8_t> row(rowBytes), prior(rowBytes, 0);
    size_t pos = 0;
    for (int y = 0; y < height; ++y) {
        std::memcpy(row.data(), src + size_t(y) * rowBytes, rowBytes);
        if (bitDepth == 16) // PNG samples are big-endian
            for (size_t i = 0; i + 1 < rowBytes; i += 2)
                std::swap(row[i], row[i + 1]);
        raw[pos++] = 2;
        for (size_t i = 0; i < rowBytes; ++i)
            raw[pos + i] = uint8_t(row[i] - prior[i]);
        pos += rowBytes;
        std::swap(row, prior);
    }

    uLongf compressedSize = compressBound(uLong(raw.size()));
    std::vector<uint8_t> compressed(compressedSize);
    if (compress2(compressed.data(), &compressedSize, raw.data(),
                  uLong(raw.size()), 6) != Z_OK)
        throw std::runtime_error("writePng: deflate failed");

    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("writePng: cannot open " + path.string());
    static const uint8_t kSignature[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
    out.write(reinterpret_cast<const char *>(kSignature), 8);

    std::vector<uint8_t> ihdr;
    appendBigEndian32(ihdr, uint32_t(width));
    appendBigEndian32(ihdr, uint32_t(height));
    ihdr.push_back(uint8_t(bitDepth));
    ihdr.push_back(channels == 1 ? 0 : 2); // color type: gray / truecolor
    ihdr.insert(ihdr.end(), {0, 0, 0});    // deflate, adaptive filters, no interlace
    writeChunk(out, "IHDR", ihdr.data(), ihdr.size());
    writeChunk(out, "IDAT", compressed.data(), compressedSize);
    writeChunk(out, "IEND", nullptr, 0);
    if (!out)
        throw std::runtime_error("writePng: write failed for " + path.string());
}

} // namespace pano
