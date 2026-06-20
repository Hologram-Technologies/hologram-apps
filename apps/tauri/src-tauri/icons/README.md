# Icons

`icon.png` is the source mark (the Hologram logo, 512×512). Generate the full platform icon set
(`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, Windows `Square*.png`) with
the standard Tauri command — run it once after cloning:

```
npm run tauri icon icons/icon.png
```

The generated files are git-ignored (see `../../.gitignore`); only `icon.png` is checked in.
