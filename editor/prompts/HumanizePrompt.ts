// cross-ref: interacts with editor/core/{ColorConfig, changes}; editor/model/{SongDocument}; synth/{SynthConfig}
// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { ColorConfig } from "../core/ColorConfig";
import { SongDocument } from "../model/SongDocument";
import { Prompt } from "./Prompt";
import { ChangeHumanizeSelectedNotes } from "../core/changes";

const { button, div, h2, input, span } = HTML;

// BreakBox Phase 5: Humanize — apply swing and/or random timing/velocity jitter
// to the notes inside the current pattern selection.
export class HumanizePrompt implements Prompt {
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width:45%;" }, "Humanize");

    private readonly _swingSlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "100", value: "20", step: "1" });
    private readonly _swingValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "20%");
    private readonly _timeSlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "12", value: "3", step: "1" });
    private readonly _timeValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "±3");
    private readonly _velocitySlider: HTMLInputElement = input({ style: "width: 90%;", type: "range", min: "0", max: "40", value: "8", step: "1" });
    private readonly _velocityValue: HTMLSpanElement = span({ style: `width: 3em; text-align: right; color: ${ColorConfig.secondaryText};` }, "±8");

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 300px;" },
        h2("Humanize"),
        div({ style: `color: ${ColorConfig.secondaryText}; font-size: smaller; margin-bottom: 0.5em;` },
            "Swing pushes every off-beat note later. Random timing/velocity add human-feel jitter. Zero = untouched.",
        ),
        div({ style: "margin: 0.25em 0;" },
            div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em;" },
                span({ style: "width: 6em;" }, "Swing:"),
                this._swingSlider,
                this._swingValue,
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
        this._swingSlider.addEventListener("input", () => { this._swingValue.textContent = this._swingSlider.value + "%"; });
        this._timeSlider.addEventListener("input", () => { this._timeValue.textContent = "±" + this._timeSlider.value; });
        this._velocitySlider.addEventListener("input", () => { this._velocityValue.textContent = "±" + this._velocitySlider.value; });

        this._okayButton.addEventListener("click", this._humanize);
        this._cancelButton.addEventListener("click", this._close);
    }

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    }

    public cleanUp = (): void => {
        this._okayButton.removeEventListener("click", this._humanize);
        this._cancelButton.removeEventListener("click", this._close);
    }

    private _humanize = (): void => {
        const pattern = this._doc.song.getPattern(this._doc.channel, this._doc.bar);
        if (pattern != null) {
            const swing: number = Math.max(0, Math.round(+this._swingSlider.value));
            const time: number = Math.max(0, Math.round(+this._timeSlider.value));
            const velocity: number = Math.max(0, Math.round(+this._velocitySlider.value));
            this._doc.record(new ChangeHumanizeSelectedNotes(this._doc, pattern, swing, time, velocity));
        }
        this._doc.prompt = null;
    }
}
