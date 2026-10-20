# Menuconfig for VS Code

Configure Kconfig projects in VS Code. The extension collects the project's
`Kconfig` files, parses them with the bundled Kconfiglib, and opens Kconfiglib's
menuconfig interface to edit options. Saving generates `.config` and the C
header `rts_cfg.h`.

## Usage

1. Install **Menuconfig for VSCode** in VS Code.
2. Install Python 3.8 or later. On Windows, install `windows-curses` in the
   Python environment used by the extension:

   ```powershell
   python -m pip install windows-curses
   ```

3. Open a project folder containing a `Kconfig` file in VS Code.
4. Click the **menuconfig** button in the status bar, or run
   **Menuconfig: Open Configuration** from the Command Palette.
5. Edit the configuration in menuconfig, press `q` to quit, and save when
   prompted.

By default, generated files are placed in the project folder:

- `.config`: saved configuration.
- `rts_cfg.h`: generated C header.
- `Kconfig.projbuild`: automatically generated Kconfig aggregate; do not edit it manually.

The terminal-based menuconfig interface is used by default. To use the
extension's graphical panel instead, set `menuconfig.ui` to `webview` in VS
Code settings.

## Third-party libraries

This extension bundles [Kconfiglib 14.1.0](https://github.com/ulfalizer/Kconfiglib),
including its `menuconfig` and `guiconfig` interfaces. They are licensed under
the ISC license; see [NOTICE](./NOTICE) for copyright and license details.
Kconfiglib does not need to be installed separately. On Windows, `windows-curses`
is an optional dependency for the terminal interface and must be installed in
the Python environment used by the extension.
