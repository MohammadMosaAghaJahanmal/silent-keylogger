"""Generate the original PDF document icon using only Python's standard library.

ICO frames are lossless RGBA PNGs, rendered with 4x antialiasing. Lettering is
outlined geometry, so the result does not depend on installed fonts or packages.
"""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]


def inside(x, y, polygon):
    hit = False
    previous = polygon[-1]
    for point in polygon:
        x1, y1 = previous
        x2, y2 = point
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
        previous = point
    return hit


PAPER = [(49, 17), (163, 17), (211, 65), (211, 226), (203, 237),
         (49, 237), (39, 227), (39, 27)]
FOLD = [(162, 17), (211, 66), (173, 66), (162, 55)]
BADGE = [(27, 101), (220, 101), (228, 109), (228, 178), (220, 186),
         (27, 186), (19, 178), (19, 109)]
# Compact bold sans-serif letter paths; the counters stay red.
LETTERS = [
    ([(48, 120), (68, 120), (79, 125), (83, 134), (81, 145), (72, 152),
      (59, 152), (59, 168), (48, 168)],
     [[(59, 130), (59, 142), (68, 142), (72, 139), (72, 133), (68, 130)]]),
    ([(94, 120), (114, 120), (127, 126), (133, 137), (133, 151),
      (127, 162), (114, 168), (94, 168)],
     [[(105, 130), (105, 158), (113, 158), (120, 153), (122, 146),
       (121, 137), (116, 131)]]),
    ([(146, 120), (179, 120), (179, 130), (157, 130), (157, 140),
      (176, 140), (176, 150), (157, 150), (157, 168), (146, 168)], []),
]


def color(x, y):
    rgba = (0, 0, 0, 0)
    if inside(x - 1, y - 4, PAPER):
        rgba = (23, 34, 51, 35)
    if inside(x, y, PAPER):
        rgba = (246, 248, 251, 255)
    if inside(x, y, FOLD):
        rgba = (206, 214, 225, 255)
    if inside(x, y, BADGE):
        # Subtle red gradient for a restrained, recognizable document badge.
        t = (y - 101) / 85
        rgba = (int(226 - 20 * t), int(53 - 18 * t), int(62 - 12 * t), 255)
    for outline, holes in LETTERS:
        if inside(x - 10, y, outline) and not any(inside(x - 10, y, h) for h in holes):
            rgba = (255, 255, 255, 255)
    if 65 <= x <= 184 and (204 <= y <= 208 or 217 <= y <= 221):
        rgba = (210, 218, 229, 255)
    return rgba


def png(size):
    rows = bytearray()
    scale = 4
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [color((x + (sx + .5) / scale) * 256 / size,
                             (y + (sy + .5) / scale) * 256 / size)
                       for sy in range(scale) for sx in range(scale)]
            alpha = sum(c[3] for c in samples)
            rgb = [round(sum(c[i] * c[3] for c in samples) / alpha)
                   if alpha else 0 for i in range(3)]
            rows.extend((*rgb, round(alpha / len(samples))))

    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data)))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    output = ROOT / 'assets'
    output.mkdir(exist_ok=True)
    frames = [(size, png(size)) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack('<HHH', 0, 1, len(frames)))
    for size, data in frames:
        directory.extend(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0,
                                     1, 32, len(data), offset))
        offset += len(data)
    (output / 'PDF.ico').write_bytes(directory + b''.join(data for _, data in frames))
    (output / 'PDF-preview.png').write_bytes(frames[-1][1])
    print(f'Created {output / "PDF.ico"}')
