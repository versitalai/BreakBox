// cross-ref: interacts with editor/core/{ColorConfig, EditorConfig, changes}; editor/model/{SongDocument}; synth/{SynthConfig, model}
// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { Config } from "../../synth/SynthConfig";
import { HTML } from "imperative-html/dist/esm/elements-strict";
import { SongDocument } from "../model/SongDocument";
import { Prompt } from "./Prompt";
import { ChangeSampleMap } from "../core/changes";
import { EditorConfig } from "../core/EditorConfig";
import { ColorConfig } from "../core/ColorConfig";

const { button, div, h2, select, option, span } = HTML;

const PITCH_NAMES: ReadonlyArray<string> = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DEFAULT_PITCH_MIN: number = 24; // C1
const DEFAULT_PITCH_MAX: number = Config.maxPitch; // 95

// BreakBox 6B: per-pitch custom sample assignment for multiSample instruments.
// Each row is a pitch; the dropdown lists the custom samples loaded via
// AddSamplesPrompt (plus "default" = instrument's own chip wave).
export class SampleMapPrompt implements Prompt {
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width:45%;" }, "Okay");
    private readonly _mapContainer: HTMLDivElement = div({ style: "max-height: 400px; overflow-y: scroll; margin: 0.5em 0;" });

    // pitch -> sample index (into EditorConfig.customSamples), -1 = default
    private readonly _selections: Map<number, number> = new Map<number, number>();
    private readonly _selects: Map<number, HTMLSelectElement> = new Map<number, HTMLSelectElement>();

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 320px;" },
        h2("Sample Map"),
        div({ style: `color: ${ColorConfig.secondaryText}; font-size: smaller; margin-bottom: 0.5em;` },
            "Assign a loaded custom sample to each pitch. Pitches left on \"default\" use the instrument's base chip wave.",
        ),
        this._mapContainer,
        div({ style: "display: flex; flex-direction: row-reverse; justify-content: space-between;" },
            this._okayButton,
        ),
        this._cancelButton,
    );

    constructor(private _doc: SongDocument) {
        const instrument = this._doc.song.channels[this._doc.channel].instruments[this._doc.getCurrentInstrument()];

        // Load current selections: sampleMap stores custom-sample indices.
        for (const [pitch, sampleIndex] of instrument.sampleMap) {
            this._selections.set(pitch, sampleIndex);
        }

        // Build pitch rows from low to high.
        const sampleNames: string[] = [];
        if (EditorConfig.customSamples != null) {
            for (const url of EditorConfig.customSamples) {
                sampleNames.push(this._sampleNameFromUrl(url));
            }
        }

        for (let pitch: number = DEFAULT_PITCH_MIN; pitch <= DEFAULT_PITCH_MAX; pitch++) {
            const octave: number = Math.floor(pitch / 12) - 1;
            const pitchName: string = PITCH_NAMES[pitch % 12] + octave;
            const selectEl: HTMLSelectElement = select({ style: "width: 14em;" });
            selectEl.appendChild(option({ value: "-1" }, "default"));
            for (let i: number = 0; i < sampleNames.length; i++) {
                selectEl.appendChild(option({ value: i + "" }, sampleNames[i] + " #" + (i + 1)));
            }
            const current: number | undefined = this._selections.get(pitch);
            setSelectedValue(selectEl, current !== undefined ? current : -1);
            selectEl.addEventListener("change", () => {
                const value: number = +selectEl.value;
                if (value < 0) {
                    this._selections.delete(pitch);
                } else {
                    this._selections.set(pitch, value);
                }
            });
            this._selects.set(pitch, selectEl);
            this._mapContainer.appendChild(div({ style: "display: flex; flex-direction: row; align-items: center; gap: 0.5em; padding: 2px 0;" },
                span({ style: "width: 4em; text-align: right; font-size: smaller;" }, pitchName),
                selectEl,
            ));
        }

        this._okayButton.addEventListener("click", this._saveChanges);
        this._cancelButton.addEventListener("click", this._close);
    }

    private _sampleNameFromUrl(url: string): string {
        try {
            return decodeURIComponent(url.replace(/^.*\//, "").split("!")[0].split(",")[0]);
        } catch (e) {
            return url;
        }
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
        const newMap: Map<number, number> = new Map<number, number>(this._selections);
        this._doc.record(new ChangeSampleMap(this._doc, newMap));
        this._doc.prompt = null;
    }
}

function setSelectedValue(selectEl: HTMLSelectElement, value: number): void {
    for (let i: number = 0; i < selectEl.options.length; i++) {
        if (+selectEl.options[i].value === value) {
            selectEl.selectedIndex = i;
            return;
        }
    }
}
