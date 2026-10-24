# Fonts embedded in the PDF report

| File | Font | Licence |
| --- | --- | --- |
| `Inter-*.ttf` | Inter 4 (Rasmus Andersson), from the `@expo-google-fonts/inter` package | SIL Open Font License 1.1 (`OFL-Inter.txt`) |
| `DejaVuSans*.ttf` | DejaVu Sans / Sans Mono 2.37, from the `dejavu-fonts-ttf` package — fallback for glyphs Inter lacks (∪, Arabic…) and for excerpts | Bitstream Vera / DejaVu licence (`LICENSE-DejaVu.txt`) |

The PDF renderer (`@react-pdf/renderer`) is pure JavaScript: no Pango, Cairo or Chromium on the server, so exports work
the same on Vercel, Linux, macOS and Windows.
