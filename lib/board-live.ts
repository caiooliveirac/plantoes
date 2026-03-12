type BoardEvent = {
    version: number;
    reason: string;
    emittedAt: string;
};

type BoardSubscriber = (event: BoardEvent) => void;

type BoardLiveState = {
    version: number;
    subscribers: Set<BoardSubscriber>;
};

function getBoardLiveState() {
    const scope = globalThis as typeof globalThis & { __boardLiveState?: BoardLiveState };
    if (!scope.__boardLiveState) {
        scope.__boardLiveState = {
            version: 0,
            subscribers: new Set(),
        };
    }

    return scope.__boardLiveState;
}

export function publishBoardUpdate(reason: string) {
    const state = getBoardLiveState();
    state.version += 1;

    const event: BoardEvent = {
        version: state.version,
        reason,
        emittedAt: new Date().toISOString(),
    };

    for (const subscriber of state.subscribers) {
        subscriber(event);
    }

    return event;
}

export function subscribeBoardUpdates(subscriber: BoardSubscriber) {
    const state = getBoardLiveState();
    state.subscribers.add(subscriber);

    return () => {
        state.subscribers.delete(subscriber);
    };
}

export function getBoardLiveVersion() {
    return getBoardLiveState().version;
}