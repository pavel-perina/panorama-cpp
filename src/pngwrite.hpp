#pragma once
// Minimal PNG writer on bare zlib — the whole format is chunks + CRC32 +
// one DEFLATE stream of filtered scanlines.

#include <filesystem>

namespace pano {

// Writes a PNG. channels: 1 (gray) or 3 (RGB); bitDepth: 8 or 16.
// `data` is row-major, native-endian samples, no padding — gray8, gray16,
// rgb24 and rgb48 all take the same path (the Up filter is byte-wise; only
// the IHDR fields and a 16-bit byteswap differ). Throws std::runtime_error
// on failure.
void writePng(const std::filesystem::path &path, int width, int height,
              int channels, int bitDepth, const void *data);

} // namespace pano
