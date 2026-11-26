// localStorage / sessionStorage that never throws: in a private window, with
// blocked storage, or in Node (the tests), nothing is remembered instead.
function area(get) {
  return {
    get(k) { try { return get().getItem(k); } catch { return null; } },
    set(k, v) { try { get().setItem(k, v); } catch { /* storage blocked */ } },
    del(k) { try { get().removeItem(k); } catch { /* storage blocked */ } },
  };
}

export const local = area(() => globalThis.localStorage);     // this browser, kept
export const session = area(() => globalThis.sessionStorage); // this tab only
