// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Editor for the NoteMap extension's per-note sample actions.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { Config } from "../../synth/SynthConfig";
import { VoiceMode } from "../../synth/registries/VoiceTypes";
import { NoteAction } from "../../synth/registries/instrumentExtensions/noteMap";
import { ColorConfig } from "../core/ColorConfig";
import { ChangeNoteMap } from "../core/changes";
import { EditorConfig } from "../core/EditorConfig";
import { SongDocument } from "../model/SongDocument";
import { Prompt } from "./Prompt";

const { button, div, h2, input, option, select, span } = HTML;
const PITCH_NAMES: ReadonlyArray<string> = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MIN_PITCH: number = 24; // C1
const MAX_PITCH: number = Config.maxPitch;

interface NoteMapRow {
    sample: HTMLSelectElement;
    mode: HTMLSelectElement;
    rootKey: HTMLInputElement;
    gain: HTMLInputElement;
}

/**
 * Maps individual notes to already-loaded custom samples. This deliberately
 * uses the song's custom sample list: mappings therefore remain shareable in
 * the song URL and do not introduce a second, hidden sample store.
 */
export class NoteMapPrompt implements Prompt {
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width: 45%;" }, "Okay");
    private readonly _mapContainer: HTMLDivElement = div({ style: "max-height: 400px; overflow-y: auto; margin: 0.5em 0;" });
    private readonly _rows: Map<number, NoteMapRow> = new Map<number, NoteMapRow>();
    private readonly _actions: Map<number, NoteAction> = new Map<number, NoteAction>();
    private readonly _sampleUrls: ReadonlyArray<string>;

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 560px; max-width: calc(100% - 30px);" },
        h2("Note Sample Map"),
        div({ style: `color: ${ColorConfig.secondaryText}; font-size: smaller; margin-bottom: 0.5em;` },
            "Assign an already-added custom sample to a note. Layer keeps the instrument sound; replace plays only the sample. Add samples first with Add Custom Samples.",
        ),
        this._mapContainer,
        div({ style: "display: flex; flex-direction: row-reverse; justify-content: space-between;" }, this._okayButton),
        this._cancelButton,
    );

    constructor(private readonly _doc: SongDocument) {
        const instrument = this._currentInstrument();
        const currentMap = instrument._noteMap;
        if (currentMap != null) {
            for (const [pitch, action] of currentMap) this._actions.set(pitch, { ...action });
        }
        this._sampleUrls = EditorConfig.customSamples != null ? EditorConfig.customSamples.slice() : [];
        this._render();
        this._okayButton.addEventListener("click", this._saveChanges);
        this._cancelButton.addEventListener("click", this._close);
    }

    public cleanUp = (): void => {
        this._okayButton.removeEventListener("click", this._saveChanges);
        this._cancelButton.removeEventListener("click", this._close);
    }

    private _currentInstrument() {
        return this._doc.song.channels[this._doc.channel].instruments[this._doc.getCurrentInstrument()];
    }

    private _render(): void {
        const headerStyle = "font-size: smaller; color: var(--secondary-text);";
        this._mapContainer.appendChild(div({ style: "display: grid; grid-template-columns: 3.5em minmax(10em, 1fr) 5em 4.5em 4em; gap: 0.35em; align-items: center; padding-bottom: 0.3em;" },
            span({ style: headerStyle }, "Note"), span({ style: headerStyle }, "Sample"), span({ style: headerStyle }, "Mode"), span({ style: headerStyle }, "Root"), span({ style: headerStyle }, "Gain"),
        ));
        for (let pitch = MIN_PITCH; pitch <= MAX_PITCH; pitch++) this._renderRow(pitch);
    }

    private _renderRow(pitch: number): void {
        const action = this._actions.get(pitch);
        const sampleSelect: HTMLSelectElement = select({ style: "width: 100%;" });
        sampleSelect.appendChild(option({ value: "" }, "default instrument"));
        for (const url of this._sampleUrls) sampleSelect.appendChild(option({ value: url }, this._sampleName(url)));
        sampleSelect.value = action?.sampleUrl || "";

        const modeSelect: HTMLSelectElement = select({ style: "width: 100%;" },
            option({ value: "layer" }, "Layer"),
            option({ value: "replace" }, "Replace"),
        );
        modeSelect.value = action?.mode === VoiceMode.Replace ? "replace" : "layer";
        const rootKey: HTMLInputElement = input({ type: "number", min: "0", max: "127", step: "1", style: "width: 100%; box-sizing: border-box;", value: String(action?.rootKey ?? pitch) });
        const gain: HTMLInputElement = input({ type: "number", min: "0", max: "2", step: "0.1", style: "width: 100%; box-sizing: border-box;", value: String(action?.gain ?? 1) });
        const row = { sample: sampleSelect, mode: modeSelect, rootKey, gain };
        this._rows.set(pitch, row);
        const update = (): void => this._updateAction(pitch, row);
        sampleSelect.addEventListener("change", update);
        modeSelect.addEventListener("change", update);
        rootKey.addEventListener("change", update);
        gain.addEventListener("change", update);
        const octave = Math.floor(pitch / 12) - 1;
        this._mapContainer.appendChild(div({ style: "display: grid; grid-template-columns: 3.5em minmax(10em, 1fr) 5em 4.5em 4em; gap: 0.35em; align-items: center; padding: 2px 0;" },
            span({ style: "text-align: right; font-size: smaller;" }, PITCH_NAMES[pitch % 12] + octave), sampleSelect, modeSelect, rootKey, gain,
        ));
    }

    private _updateAction(pitch: number, row: NoteMapRow): void {
        if (row.sample.value === "") {
            this._actions.delete(pitch);
            return;
        }
        const parsedRootKey = Number(row.rootKey.value);
        const parsedGain = Number(row.gain.value);
        const rootKey = Math.max(0, Math.min(127, Math.round(Number.isFinite(parsedRootKey) ? parsedRootKey : pitch)));
        const gain = Math.max(0, Math.min(2, Number.isFinite(parsedGain) ? parsedGain : 1));
        this._actions.set(pitch, {
            sampleUrl: row.sample.value,
            mode: row.mode.value === "replace" ? VoiceMode.Replace : VoiceMode.Layer,
            rootKey,
            gain,
        });
    }

    private _saveChanges = (): void => {
        this._doc.record(new ChangeNoteMap(this._doc, this._actions));
        this._doc.prompt = null;
    }

    private _close = (): void => {
        this._doc.prompt = null;
    }

    private _sampleName(url: string): string {
        const withoutOptions = url.split("!")[0].split(",")[0];
        const lastSlash = withoutOptions.lastIndexOf("/");
        try {
            return decodeURIComponent(lastSlash >= 0 ? withoutOptions.slice(lastSlash + 1) : withoutOptions) || url;
        } catch (_error) {
            return withoutOptions || url;
        }
    }
}
