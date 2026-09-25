# Fonts

The UI's fonts are served from this folder (`fonts.css`, linked from `src/index.html`), so the app looks the same
with no internet connection.

| Files | Font | Used for | License |
|---|---|---|---|
| `roboto-{300,400,500}-{latin,latin-ext,greek}.woff2` | Roboto | all text (`body`, Angular Material) | Apache 2.0 |
| `material-icons.woff2` | Material Icons | every `<mat-icon>` (ligature font: the icon's name is its text) | Apache 2.0 |
| `material-symbols-outlined-folder_check.woff2` | Material Symbols Outlined, subset to the single `folder_check` icon | the icon on the "Synchronize directories" screen | Apache 2.0 |

All are the woff2 files Google Fonts serves for these families. Roboto is limited to the Latin, Latin Extended and
Greek subsets; a character outside them (e.g. Cyrillic in a file name) is drawn with the system font instead.

To add another Material Symbols icon, or another Roboto subset or weight, download the woff2 file Google Fonts
returns for it and add a matching `@font-face` block to `fonts.css`.
