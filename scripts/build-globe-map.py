"""Unproject the painted globe into an equirectangular map and preview the spin.

Usage (needs numpy and Pillow; the source is the full-size painting from the design package):
  python scripts/build-globe-map.py prototypes/roundtable-chaldea/assets/chaldeas-globe-v2.png \
      src/ui/scenes/roundtable-globe-map.webp preview.png
The roundtable board spins this map in src/ui/board-roundtable-globe.js; CX, CY, R and PHI0
below must match the constants there.

The painting shows one hemisphere seen from latitude PHI0. Each map row keeps the longitudes
that are clearly visible (mu > MARGIN, away from the baked atmosphere ring). Towards that edge
the continents erode into ocean along their own weaker pixels, so they end in a coastline.
The far side is open ocean: a translated, land-free copy of the visible ocean and clouds,
cross-faded at both seams. No mirroring, so nothing appears twice or symmetric.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SRC, OUT, PREVIEW = sys.argv[1], sys.argv[2], sys.argv[3]
CX, CY, R = 623.2, 622.0, 584.2
PHI0 = np.radians(20.0)
MARGIN = 0.32
ERODE = np.radians(26)   # width of the band where continents give way to ocean
BLEND = np.radians(22)   # cross-fade between the visible side and the open ocean
TW, TH = 2048, 1024

rgba = np.asarray(Image.open(SRC).convert("RGBA")).astype(np.float32) / 255.0
img = rgba[..., :3]


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# Land: green/tan (G close to B); ocean and clouds are clearly bluer; ice is very bright.
ratio = img[..., 1] / np.maximum(img[..., 2], 1e-3)
land = smooth(0.70, 0.84, ratio) * (1 - smooth(0.86, 0.95, img[..., 2]))

# Ocean field under the land: normalised blur of ocean-only pixels.
def box(arr, r, axis):
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(arr, pad, mode="edge"), axis=axis)
    hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
    lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
    return (hi - lo) / (2 * r + 1)


def blur(arr, radius):
    # Three box passes per axis approximate a Gaussian.
    r = max(1, int(radius / 1.7))
    for _ in range(3):
        arr = box(box(arr, r, 0), r, 1)
    return arr

ice = smooth(0.84, 0.92, img[..., 2]) * smooth(0.6, 0.8, img[..., 0])
# Open water away from the baked atmosphere ring at the rim.
yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
interior = (np.hypot(xx - CX, yy - CY) < R * 0.9)[..., None]
w = ((1 - land) * (1 - ice))[..., None] * interior
lum = img @ np.array([0.3, 0.59, 0.11], dtype=np.float32)
# Deep water without clouds sets the fill colour; far from any sea (Sahara) it falls back to
# the mean deep-water colour.
deep = w * (lum < 0.30)[..., None]
mean_deep = (img * deep).reshape(-1, 3).sum(0) / max(float(deep[..., 0].sum()), 1.0)
eps = 0.08
fill = (blur(img * deep, 90) + mean_deep * eps) / (blur(np.repeat(deep, 3, -1), 90) + eps)
# Clouds over open water, transplanted from two other parts of the ocean onto the fill.
clouds = np.clip(img - fill, 0, 1) * w
transplant = np.maximum(np.roll(clouds, (217, -163), (0, 1)), np.roll(clouds, (-191, 239), (0, 1)))
ocean = fill + transplant
# The far side removes land and ice entirely, coastal fringe and its darker shelf included.
gone_back = np.clip(blur(np.maximum(land, ice)[..., None], 9)[..., 0] * 2.2, 0, 1)
stack = np.concatenate([img, ocean, land[..., None], gone_back[..., None]], -1)  # 8 channels


def bilinear(image, x, y):
    h, w_ = image.shape[:2]
    x = np.clip(x, 0, w_ - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    a = image[y0, x0] * (1 - fx) + image[y0, x0 + 1] * fx
    b = image[y0 + 1, x0] * (1 - fx) + image[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def sample(lon, lat):
    x = np.cos(lat) * np.sin(lon)
    y = np.cos(PHI0) * np.sin(lat) - np.sin(PHI0) * np.cos(lat) * np.cos(lon)
    return bilinear(stack, CX + x * R, CY - y * R)


lon = (np.arange(TW) + 0.5) / TW * 2 * np.pi - np.pi
lat = np.pi / 2 - (np.arange(TH) + 0.5) / TH * np.pi
LON, LAT = np.meshgrid(lon, lat)

k = (MARGIN - np.sin(PHI0) * np.sin(lat)) / np.maximum(np.cos(PHI0) * np.cos(lat), 1e-6)
width = np.where(k <= -1, np.pi, np.arccos(np.clip(k, -1, 1)))
usable = width >= np.radians(24)
last = np.max(np.nonzero(usable)[0])
row_lat = lat.copy()
row_lat[last + 1:] = lat[last]
width = np.minimum(width, np.pi - BLEND - 0.05)
width[last + 1:] = width[last]
Wd = width[:, None] * np.ones_like(LON)
LATs = row_lat[:, None] * np.ones_like(LON)

# Visible side with eroding continents.
A = np.abs(LON)
front = sample(np.clip(LON, -Wd, Wd), LATs)
erosion = smooth(Wd - ERODE, Wd, A)                   # 0 inside, 1 at the edge
strength = front[..., 6]
gone = smooth(strength * 0.9 - 0.06, strength * 0.9 + 0.06, erosion) * strength
front_rgb = front[..., :3] * (1 - gone[..., None]) + front[..., 3:6] * gone[..., None]

# Far side: the visible band translated around the back, land removed entirely.
L2 = np.mod(LON, 2 * np.pi)                              # 0..2pi, front centred on 0 and 2pi
start, end = Wd - BLEND, 2 * np.pi - Wd + BLEND
t = np.clip((L2 - start) / (end - start), 0, 1)
back = sample(-Wd + t * 2 * Wd, LATs)
back_rgb = back[..., :3] * (1 - back[..., 7:8]) + back[..., 3:6] * back[..., 7:8]
wb = smooth(Wd - BLEND, Wd, A)
tex = front_rgb * (1 - wb[..., None]) + back_rgb * wb[..., None]
Image.fromarray((np.clip(tex, 0, 1) * 255).astype(np.uint8)).save(OUT, quality=86, method=6)

# Preview with the runtime projection and shading.
N = 360
u = (np.arange(N) + 0.5) / N * 2 - 1
X, Y = np.meshgrid(u, -u)
r2 = X ** 2 + Y ** 2
inside = r2 < 1
Z = np.sqrt(np.clip(1 - r2, 0, 1))
plat = np.arcsin(np.clip(Z * np.sin(PHI0) + Y * np.cos(PHI0), -1, 1))
plon = np.arctan2(X, Z * np.cos(PHI0) - Y * np.sin(PHI0))
light = np.array([-0.35, 0.45, 0.82]); light /= np.linalg.norm(light)
shade = 0.82 + 0.3 * (X * light[0] + Y * light[1] + Z * light[2])
haze = (1 - Z) ** 3
frames = []
for spin in (0, 60, 120, 180, 240, 300):
    Lp = (plon + np.radians(spin) + np.pi) % (2 * np.pi)
    tx = Lp / (2 * np.pi) * TW - 0.5
    ty = (np.pi / 2 - plat) / np.pi * TH - 0.5
    col = bilinear(tex, tx, ty) * shade[..., None]
    col = col * (1 - 0.55 * haze[..., None]) + np.array([0.55, 0.86, 0.95]) * 0.55 * haze[..., None]
    out = np.zeros((N, N, 3)); out[inside] = col[inside]
    frames.append(out)
grid = np.concatenate([np.concatenate(frames[:3], 1), np.concatenate(frames[3:], 1)], 0)
Image.fromarray((np.clip(grid, 0, 1) * 255).astype(np.uint8)).save(PREVIEW)
print("ok")
