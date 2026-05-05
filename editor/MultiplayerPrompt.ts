// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { Prompt } from "./Prompt";
import { SongDocument } from "./SongDocument";

const { button, div, input, h2 } = HTML;

export class MultiplayerPrompt implements Prompt {
    private readonly _idInputBox: HTMLInputElement = input({
        style: "width: 100%; height: 1.5em; font-size: 80%; margin-left: 0.4em; vertical-align: middle; text-align: center;",
        type: "text",
        placeholder: "Enter Peer ID...",
        value: ""
    });
    private readonly _myIdDisplay: HTMLDivElement = div({
        style: "font-size: 80%; color: #94a3b8; text-align: center; margin-bottom: 10px;",
        innerText: "Your ID: Loading..."
    });
    private readonly _connectButton: HTMLButtonElement = button({
        style: "width: 100%; height: 2em; margin-top: 10px; cursor: pointer; background: #a855f7; color: white; border: none; border-radius: 10px; font-weight: bold;",
        innerText: "Connect"
    });
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 300px;" },
        h2("Multiplayer Connection"),
        this._myIdDisplay,
        div({ style: "margin: 10px 0; font-size: 80%; text-align: center;" }, "Connect to a friend to jam together!"),
        this._idInputBox,
        this._connectButton,
        this._cancelButton,
    );

    constructor(private readonly _doc: SongDocument) {
        this._myIdDisplay.innerText = "Your ID: " + this._doc.multiplayer.myId;
        
        this._connectButton.onclick = () => {
            const targetId = this._idInputBox.value.trim();
            if (targetId) {
                this._doc.multiplayer.connect(targetId);
                this._doc.prompt = null;
            }
        };
    }

    public cleanUp(): void {
        // Clean up any event listeners or resources
    }
}
