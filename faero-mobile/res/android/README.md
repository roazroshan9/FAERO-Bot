# res/android/ — App Icons & Splash Screen

Place your launcher icons and splash images here.
Cordova reads these paths from `config.xml` and copies them into the
Android platform during `cordova prepare`.

## Required icon sizes (mipmap PNG, square)

| Folder             | Size      | DPI   |
|--------------------|-----------|-------|
| mipmap-mdpi/       | 48×48 px  | ~160  |
| mipmap-hdpi/       | 72×72 px  | ~240  |
| mipmap-xhdpi/      | 96×96 px  | ~320  |
| mipmap-xxhdpi/     | 144×144 px| ~480  |
| mipmap-xxxhdpi/    | 192×192 px| ~640  |

Each folder needs a file named `ic_launcher.png`.

## Splash screen

Place a single `drawable/splash.png` (recommended 1280×1920 px) in
`res/android/drawable/splash.png`.

## Quick way to generate icons

Use Android Studio's **Image Asset Studio** (File → New → Image Asset)
and export into the correct mipmap folders, then copy them here.
