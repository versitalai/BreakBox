import { SongDocument } from "./SongDocument";
import { Peer } from "peerjs";

export class MultiplayerManager {
    private peer: Peer | null = null;
    private connection: any = null;
    private doc: SongDocument;
    private isHost: boolean = false;
    public myId: string = "";
    public connected: boolean = false;

    constructor(doc: SongDocument) {
        this.doc = doc;
    }

    public init(customId?: string) {
        this.peer = customId ? new Peer(customId) : new Peer();

        this.peer.on("open", (id: string) => {
            this.myId = id;
            console.log("My Peer ID is: " + id);
        });

        this.peer.on("connection", (conn: any) => {
            this.isHost = true;
            this.setupConnection(conn);
        });
    }

    public connect(targetId: string) {
        if (!this.peer) throw new Error("Peer not initialized");
        const conn = this.peer.connect(targetId);
        this.isHost = false;
        this.setupConnection(conn);
    }

    private setupConnection(conn: any) {
        this.connection = conn;

        conn.on("open", () => {
            console.log("Connected to peer!");
            this.connected = true;
            // Host sends the current song state immediately upon connection
            if (this.isHost) {
                this.syncState();
                // Close the Multiplayer Connection prompt if it's open
                this.doc.prompt = null;
            }
        });

        conn.on("data", (data: any) => {
            if (typeof data === "string") {
                console.log("Received song update from peer");
                // Guest updates their state based on the Host's string
                // We use a simple last-writer-wins / Host-wins approach
                if (!this.isHost) {
                    // In a more complex setup, we'd check timestamps or versions
                    // For now, Guests just accept the Host's state
                    const songString = data;
                    // We trigger the change via a manual hash update
                    window.location.hash = songString;
                    // Force the document to update from the new hash
                    this.doc.notifier.notifyWatchers(); 
                    // Note: SongDocument.ts already has a hashchange listener
                }
            }
        });

        conn.on("close", () => {
            console.log("Connection closed");
            this.connected = false;
            this.connection = null;
        });
    }

    public syncState() {
        if (this.connection && this.connection.open) {
            const songString = this.doc.song.toBase64String();
            this.connection.send(songString);
        }
    }
}
