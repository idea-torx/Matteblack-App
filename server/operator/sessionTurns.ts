// Reserve before any asynchronous preparation. A cancelled waiter keeps its
// place until its predecessor exits, so rapid follow-ups cannot jump the queue.
const turns = new Map<string, { ac: AbortController; done: Promise<void> }>();

function createTurn(sessionId?: string) {
  const previous = sessionId ? turns.get(sessionId) : undefined;
  const ac = new AbortController();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const ids = new Set<string>();
  const turn = {
    ac,
    done,
    ready: previous?.done ?? Promise.resolve(),
    identify(id: string) {
      // A later request may already own this id while waiting for us to exit.
      if (ids.has(id)) return;
      ids.add(id);
      turns.set(id, turn);
    },
    finish() {
      for (const id of ids) if (turns.get(id) === turn) turns.delete(id);
      release();
    },
  };
  if (sessionId) turn.identify(sessionId);
  previous?.ac.abort();
  return turn;
}

export function claimSessionTurn(sessionId?: string, review = false) {
  // A background review must never displace an artist's waiting/running turn.
  if (review && sessionId && turns.has(sessionId)) return undefined;
  return createTurn(sessionId);
}
