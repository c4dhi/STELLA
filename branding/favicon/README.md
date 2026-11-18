# STELLA favicon

One icon set for the app (`frontend-ui/public/`) and the docs site (`docs-site/static/`), made from the STELLA logo (`docs-site/static/img/stella-logo.svg`) (#133).

| File | Made from | Size |
|---|---|---|
| `favicon.svg` | this folder's `favicon.svg` (the logo cropped to its circle) | vector |
| `favicon.ico` | `favicon.svg` rendered at 16, 32 and 48 px, one frame each | 16/32/48 |
| `icon-192.png`, `icon-512.png` | `favicon.svg` | 192, 512 |
| `apple-touch-icon.png` | `apple-touch-icon.svg` (opaque square; iOS rounds the corners and turns transparency black) | 180 |
| `site.webmanifest` | this folder's copy | |

To change the icon, edit the SVGs here, then render each size straight from the SVG (not by shrinking a large PNG, which blurs the 16 px one). Any SVG renderer will do; these were rendered with headless Chrome on a transparent background, and the `.ico` was put together from the 16, 32 and 48 px PNGs with Pillow (`Image.save(..., format="ICO", sizes=[...], append_images=[...])`). Copy the results into both `frontend-ui/public/` and `docs-site/static/`.
