// NoteLayerPicker - UI for selecting which overlapping note to edit
import { HTML } from "imperative-html/dist/esm/elements-strict";
import { Note } from "../synth/synth";

const { div, button } = HTML;

export class NoteLayerPicker {
    private readonly _container: HTMLDivElement;
    private readonly _buttons: HTMLButtonElement[] = [];
    private _callback: ((note: Note) => void) | null = null;

    constructor() {
        this._container = div({ class: "prompt noSelection", style: "position: absolute; z-index: 1000; display: none;" });
        document.body.appendChild(this._container);
    }

    public show(notes: Note[], targetElement: HTMLElement | SVGSVGElement, callback: (note: Note) => void): void {
        this._callback = callback;

        // Clear existing buttons
        this._buttons.forEach(b => b.remove());
        this._buttons.length = 0;

        // Create a button for each note layer
        notes.forEach((note, index) => {
            const layerName = index === 0 ? "Base" : `Layer ${index + 1}`;
            const btn = button({ 
                class: "noteLayerButton",
                style: "display: block; width: 100%; text-align: left; padding: 4px 8px; font-size: 12px;"
            }, `${layerName} (ID: ${note.noteId}, pitch: ${note.pitches[0]}, len: ${note.end - note.start})`);
            
            btn.addEventListener("click", () => {
                this.hide();
                if (this._callback) this._callback(note);
            });
            
            this._buttons.push(btn);
            this._container.appendChild(btn);
        });

        // Position near target element
        const rect = targetElement.getBoundingClientRect();
        this._container.style.left = `${rect.left}px`;
        this._container.style.top = `${rect.bottom + 4}px`;
        this._container.style.display = "block";
    }

    public hide(): void {
        this._container.style.display = "none";
        this._callback = null;
    }

    public isVisible(): boolean {
        return this._container.style.display !== "none";
    }
}