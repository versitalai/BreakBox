// Regression coverage for failures that previously escaped the model/serialization suite.
// These tests deliberately exercise the editor's pending-change and audio-engine defaults.

import { PatternEditor } from "../editor/widgets/PatternEditor";
import { SongDocument } from "../editor/model/SongDocument";
import { LegacySynthAdapter } from "../editor/audio/LegacySynthAdapter";
import { di } from "../synth/DI";

describe("editor regression coverage", () => {
    afterEach(() => {
        di.reset();
    });

    it("keeps the mouse-press ChangeSequence as the prospective drag change", () => {
        // Avoid the large SVG constructor: this test targets the press state machine.
        const editor = Object.create(PatternEditor.prototype) as any;
        const prospectiveChanges: unknown[] = [];
        editor._doc = {
            channel: 0,
            prefs: { enableNotePreview: false },
            song: { getChannelIsMod: () => false },
            lastChangeWas: () => false,
            setProspectiveChange: (change: unknown) => prospectiveChanges.push(change),
        };
        editor._mouseX = 0;
        editor._mouseY = 0;
        editor._shiftHeld = false;
        editor._cursor = { valid: false, curNotes: [] };
        editor.modDragValueLabel = document.createElement("div");
        editor.stopEditingModLabel = jest.fn();
        editor._updateCursorStatus = jest.fn();
        editor._updatePreview = jest.fn();
        editor._cursorAtStartOfSelection = () => false;
        editor._cursorAtEndOfSelection = () => false;
        editor._cursorIsInSelection = () => false;
        editor._updateSelection = jest.fn();

        editor._whenCursorPressed();

        expect(editor._dragChange).toBeDefined();
        expect(prospectiveChanges).toEqual([editor._dragChange]);
    });

    it("uses the complete legacy synth when no experimental engine is registered", () => {
        const doc = new SongDocument();

        expect((doc as any).audioEngine).toBeInstanceOf(LegacySynthAdapter);
        expect((doc as any).audioEngine.inner).toBe(doc.synth);
    });
});
