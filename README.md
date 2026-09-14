# Slarmoo's Box Testing

Slarmoo's Box is an online tool for sketching and sharing instrumental music.
You can find it [here](https://github.com/slarmoo/slarmoosbox/).
It is a modification of [Ultrabox](https://ultraabox.github.io), which is a modification of [JummBox](https://github.com/jummbus/jummbox), which inturn is a modification of the [original BeepBox](https://beepbox.co).

Slarmoo's Box is a mod of Ultrabox that aims to advance Beepbox's capabilities. Feel free to contribute!


All song data is packaged into the URL at the top of your browser. When you make
changes to the song, the URL is updated to reflect your changes. When you are
satisfied with your song, just copy and paste the URL to save and share your
song!

Slarmoo's Box, as well as the beepmods which it's based on, are free projects. If you ever feel so inclined, please support the original creator, [John Nesky](http://www.johnnesky.com/), via
[PayPal](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=QZJTX9GRYEV9N&currency_code=USD)!

## Compiling and previewing

BreakBox uses Node.js and npm. The primary build tooling is written in Node, so the normal editor workflow is the same on Windows and Linux—no Git Bash or platform-specific helper scripts required.

After cloning the repository and installing dependencies:

```
npm install
npm run verify
npm run serve
```

- `verify` runs the complete Jest suite and rebuilds every browser bundle without changing the repository-root deployment copies.
- `serve` previews the repository root at `http://127.0.0.1:8080/`, matching GitHub Pages’ layout.
- `deploy` rebuilds all targets **and** syncs the generated public files from `website/` into the repository root. Use it only when preparing a Pages deployment.

Targeted builds remain available when iterating on one area:

- `build-synth`
- `build-editor`
- `build-player`
- `build-website`

## Code

The code is divided into several folders. This architecture is identical to BeepBox's.

The [synth/](synth) folder has just the code you need to be able to play Slarmoo's Box
songs out loud, and you could use this code in your own projects, like a web
game. After compiling the synth code, open website/synth_example.html to see a
demo using it. To rebuild just the synth code, run:

```
npm run build-synth
```

The [editor/](editor) folder has additional code to display the online song
editor interface. After compiling the editor code, open website/index.html to
see the editor interface. To rebuild just the editor code, run:

```
npm run build-editor
```

The [player/](player) folder has a miniature song player interface for embedding
on other sites. To rebuild just the player code, run:

```
npm run build-player
```

The [website/](website) folder contains index.html files to view the interfaces.
The build process outputs JavaScript files into this folder.

## Dependencies

Most of the dependencies are listed in [package.json](package.json), although
 Slarmoo's Box also has an indirect, optional dependency on
[lamejs](https://www.npmjs.com/package/lamejs) via
[jsdelivr](https://www.jsdelivr.com/) for exporting .mp3 files. If the user
attempts to export an .mp3 file, Slarmoo's Box will direct the browser to download
that dependency on demand. 
Additionally, random envelopes rely on [js-xxhash](https://npmjs.com/package/js-xxhash) for fast hashing. 


## Offline version

If you'd like to BUILD the offline version, enter the following into the command line of your choice:
```
npm run build-offline
```


After building, you can then enter the following to run it for testing purposes:
```
npm run start
```

And to package, run (do ```npm run package-host``` for your host platform; you may need to run git bash as an administrator for non-host platforms):
```
npm run package
```
