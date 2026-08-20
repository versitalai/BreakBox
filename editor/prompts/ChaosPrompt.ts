// cross-ref: interacts with editor/core/{ColorConfig, changes}; editor/model/{SongDocument}; synth/{SynthConfig}
// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { ColorConfig } from "../core/ColorConfig";
import { SongDocument } from "../model/SongDocument";
import { Prompt } from "./Prompt";
import { ChangeRandomizeSelectedNotes } from "../core/changes";

const { button, div, h2, input, span } = HTML;

// BreakBox Phase 4: Chaos tool — randomize pitch, timing, and velocity of the
// notes inside the current pattern selection.
export class ChaosPrompt implements Prompt {
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width:45%;" }, "Randomize");

    private readonly _pitchSlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "12", value: "2", step: "1" });
    private readonly _pitchValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "±2");
    private readonly _timeSlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "24", value: "4", step: "1" });
    private readonly _timeValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "±4");
    private readonly _velocitySlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "40", value: "10", step: "1" });
    private readonly _velocityValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "±10");

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 300px;" },
        h2("Chaos"),
        div({ style: `color: ${ColorConfig.secondaryText}; font-size: smaller; margin-bottom: 0.5em;` },
            "Randomize the notes inside the current selection. Zero = keep that property untouched.",
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Pitch (semi):"),
                this._pitchSlider,
                this._pitchValue,
            ),
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Timing (parts):"),
                this._timeSlider,
                this._timeValue,
            ),
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Velocity:"),
                this._velocitySlider,
                this._velocityValue,
            ),
        ),
        div({ style: "display: flex; flex-direction: row-reverse; justify-content: space-between;" },
            this._okayButton,
        ),
        this._cancelButton,
    );

    constructor(private _doc: SongDocument) {
        this._pitchSlider.addEventListener("input", () => { this._pitchValue.textContent = "±" + this._pitchSlider.value; });
        this._timeSlider.addEventListener("input", () => { this._timeValue.textContent = "±" + this._timeSlider.value; });
        this._velocitySlider.addEventListener("input", () => { this._velocityValue.textContent = "±" + this._velocitySlider.value; });

        this._okayButton.addEventListener("click", this._randomize);
        this._cancelButton.addEventListener("click", this._close);
    }

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    }

    public cleanUp = (): void => {
        this._okayButton.removeEventListener("click", this._randomize);
        this._cancelButton.removeEventListener("click", this._close);
    }

    private _randomize = (): void => {
        const pattern = this._doc.song.getPattern(this._doc.channel, this._doc.bar);
        if (pattern != null) {
            const pitch: number = Math.max(0, Math.round(+this._pitchSlider.value));
            const time: number = Math.max(0, Math.round(+this._timeSlider.value));
            const velocity: number = Math.max(0, Math.round(+this._velocitySlider.value));
            this._doc.record(new ChangeRandomizeSelectedNotes(this._doc, pattern, pitch, time, velocity));
        }
        this._doc.prompt = null;
    }
}
