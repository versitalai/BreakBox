// cross-ref: interacts with editor/core/{ColorConfig, changes}; editor/model/{SongDocument}; synth/{model}
// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { ColorConfig } from "../core/ColorConfig";
import { SongDocument } from "../model/SongDocument";
import { Prompt } from "./Prompt";
import { ChangeNoteGenerative } from "../core/changes";
import { Note } from "../../synth/model";

const { button, div, h2, input, span } = HTML;

// BreakBox Phase 3: per-note generative settings — probability (chance the
// note triggers each bar) and rollCount (times the note repeats within its
// duration).
export class NoteGenerativePrompt implements Prompt {
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width:45%;" }, "Okay");

    private readonly _probabilitySlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "100", value: "100", step: "1" });
    private readonly _probabilityValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "100%");
    private readonly _rollSlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "1", max: "16", value: "1", step: "1" });
    private readonly _rollValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "1");

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 300px;" },
        h2("Note Generative Settings"),
        div({ style: `color: ${ColorConfig.secondaryText}; font-size: smaller; margin-bottom: 0.5em;` },
            "Probability: chance this note triggers each bar. Roll: how many times it repeats within its duration.",
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Probability:"),
                this._probabilitySlider,
                this._probabilityValue,
            ),
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Roll count:"),
                this._rollSlider,
                this._rollValue,
            ),
        ),
        div({ style: "display: flex; flex-direction: row-reverse; justify-content: space-between;" },
            this._okayButton,
        ),
        this._cancelButton,
    );

    constructor(private _doc: SongDocument, private _pattern: any, private _note: Note) {
        this._probabilitySlider.value = _note.probability + "";
        this._probabilityValue.textContent = _note.probability + "%";
        this._rollSlider.value = _note.rollCount + "";
        this._rollValue.textContent = _note.rollCount + "";

        this._probabilitySlider.addEventListener("input", () => {
            this._probabilityValue.textContent = this._probabilitySlider.value + "%";
        });
        this._rollSlider.addEventListener("input", () => {
            this._rollValue.textContent = this._rollSlider.value;
        });

        this._okayButton.addEventListener("click", this._saveChanges);
        this._cancelButton.addEventListener("click", this._close);
    }

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    }

    public cleanUp = (): void => {
        this._okayButton.removeEventListener("click", this._saveChanges);
        this._cancelButton.removeEventListener("click", this._close);
    }

    private _saveChanges = (): void => {
        const probability: number = Math.max(0, Math.min(100, Math.round(+this._probabilitySlider.value)));
        const rollCount: number = Math.max(1, Math.min(16, Math.round(+this._rollSlider.value)));
        this._doc.record(new ChangeNoteGenerative(this._doc, this._pattern, this._note, probability, rollCount));
        this._doc.prompt = null;
    }
}
