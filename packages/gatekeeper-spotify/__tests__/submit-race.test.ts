// An auto-approved action can be applied while submitActionForApproval is still awaiting the
// overseer's reply. These drive the real gatekeeper class with an approval queue that applies
// before it returns, as the overseer's auto-approval drain may.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/spotify-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/account-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/playlist-configurator-ui.txt", () => ({ default: "" }));

const { SpotifyGatekeeperImpl } = await import("../src/spotify");

function gatekeeper() {
  const kv = new Map<string, unknown>();
  const ctx = {
    props: { userObjectId: "user", resourceKind: "account" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => ({ getAccessToken: async () => "token" }) } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new SpotifyGatekeeperImpl(ctx as never, {} as never), kv };
}

// A queue whose submitAction applies the action before replying, then replies or loses the reply.
function applyingQueue(gk: InstanceType<typeof SpotifyGatekeeperImpl>, reply: "ok" | "lost") {
  return {
    submitAction: async (id: number) => {
      await gk.applyAction(id).catch(() => {});
      if (reply === "lost") throw new Error("Network connection lost.");
    },
  } as never;
}

const pause = (gk: InstanceType<typeof SpotifyGatekeeperImpl>) => gk.preparePlayer({ op: "pause" });
const presentation = { title: "Pause playback", implementsRevert: false };

afterEach(() => vi.unstubAllGlobals());

describe("submitActionForApproval when the action is applied before the reply", () => {
  it("leaves an applied action retired instead of reviving it as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await gk.submitActionForApproval(applyingQueue(gk, "ok"), action, presentation);
    expect(kv.has(`action:${action.approvalId}`)).toBe(false);
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("keeps an apply failure as failed, not pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await gk.submitActionForApproval(applyingQueue(gk, "ok"), action, presentation);
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed" });
  });

  it("reports success when the reply is lost after the action applied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await expect(gk.submitActionForApproval(applyingQueue(gk, "lost"), action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("keeps a failed apply for a retry when the reply is lost", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    await expect(gk.submitActionForApproval(applyingQueue(gk, "lost"), action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "failed" });
  });

  it("keeps an action whose apply is still under way when the reply is lost", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>(resolve => {
      release = () => resolve(new Response(null, { status: 204 }));
    }));
    vi.stubGlobal("fetch", fetch);
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    let applying: Promise<void> | undefined;
    const queue = { submitAction: async (id: number) => {
      applying = gk.applyAction(id);
      throw new Error("Network connection lost.");
    } } as never;
    await expect(gk.submitActionForApproval(queue, action, presentation)).resolves.toBeUndefined();
    expect(kv.get(`action:${action.approvalId}`)).toMatchObject({ state: "pending" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    release!();
    await applying;
    expect(kv.get(`retiredAction:${action.approvalId}`)).toMatchObject({ state: "approved" });
  });

  it("still drops the record and fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    const action = pause(gk);
    const queue = { submitAction: async () => { throw new Error("queue gone"); } } as never;
    await expect(gk.submitActionForApproval(queue, action, presentation)).rejects.toThrow("queue gone");
    expect(kv.has(`action:${action.approvalId}`)).toBe(false);
  });
});

// A playlist "p1" served over the stubbed fetch. Each write takes the next entry of `failures`:
// "lost" lands the write and then loses its reply, "refused" answers 429 without landing it.
function fakePlaylist(initial: string[]) {
  const playlist = { uris: [...initial], writes: 0, failures: [] as ("lost" | "refused" | undefined)[] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (method === "GET" && pathname === "/v1/playlists/p1") {
      return Response.json({ id: "p1", name: "P", uri: "spotify:playlist:p1", owner: { id: "user" },
        items: { total: playlist.uris.length } });
    }
    if (pathname !== "/v1/playlists/p1/items") throw new Error(`Unexpected ${method} ${pathname}`);
    if (method === "GET") {
      const album = { id: "al", name: "Album", uri: "spotify:album:al" };
      return Response.json({ total: playlist.uris.length,
        items: playlist.uris.map(uri => ({ item: { id: uri, name: uri, uri, album } })) });
    }
    const failure = playlist.failures.shift();
    if (failure === "refused") return Response.json({ error: { message: "Too many requests" } }, { status: 429 });
    playlist.writes++;
    const body = JSON.parse(init.body as string);
    if (method === "POST") playlist.uris.splice(body.position ?? playlist.uris.length, 0, ...body.uris);
    else if (body.uris) playlist.uris = body.uris;
    else {
      const moved = playlist.uris.splice(body.range_start, body.range_length);
      const before = body.insert_before > body.range_start ? body.insert_before - body.range_length : body.insert_before;
      playlist.uris.splice(before, 0, ...moved);
    }
    if (failure === "lost") throw new TypeError("Network connection lost.");
    return Response.json({ snapshot_id: "snapshot" });
  }));
  return playlist;
}

// Submits an action that is left pending for the test to apply.
async function submitted(gk: InstanceType<typeof SpotifyGatekeeperImpl>, action: { approvalId: number }) {
  await gk.submitActionForApproval({ submitAction: async () => {} } as never, action as never,
    { title: "Edit playlist", implementsRevert: true });
  return action.approvalId;
}

describe("re-applying a playlist edit whose earlier attempt is unknown", () => {
  it("won't add the tracks again after an add whose reply was lost", async () => {
    const playlist = fakePlaylist(["A", "B"]);
    playlist.failures = ["lost"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistAdd("p1", ["X"]));

    await expect(gk.applyAction(id)).rejects.toThrow("Network connection lost.");
    await expect(gk.applyAction(id)).rejects.toThrow(/may have gone through/);

    expect(playlist.writes).toBe(1);
    expect(playlist.uris).toEqual(["A", "B", "X"]);
    expect(kv.get(`action:${id}`)).toMatchObject({ state: "failed", revert: { previousUris: ["A", "B"] } });
  });

  it("won't move a range again after a reorder whose reply was lost", async () => {
    const playlist = fakePlaylist(["A", "B", "C"]);
    playlist.failures = ["lost"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistReorder("p1", 0, 3, 1));

    await expect(gk.applyAction(id)).rejects.toThrow("Network connection lost.");
    await expect(gk.applyAction(id)).rejects.toThrow(/may have gone through/);

    expect(playlist.writes).toBe(1);
    expect(playlist.uris).toEqual(["B", "C", "A"]);
    expect(kv.get(`action:${id}`)).toMatchObject({ state: "failed", revert: { previousUris: ["A", "B", "C"] } });
  });

  it("won't resend an add after a later chunk failed once an earlier one landed", async () => {
    const playlist = fakePlaylist(["A"]);
    playlist.failures = [undefined, "refused"];
    const { gk } = gatekeeper();
    const uris = Array.from({ length: 101 }, (_, i) => `T${i}`);
    const id = await submitted(gk, gk.preparePlaylistAdd("p1", uris));

    await expect(gk.applyAction(id)).rejects.toThrow("Too many requests");
    await expect(gk.applyAction(id)).rejects.toThrow(/may have gone through/);
    expect(playlist.writes).toBe(1);
  });

  it("applies once on a retry after Spotify refused the first write, and reverts to the original", async () => {
    const playlist = fakePlaylist(["A", "B"]);
    playlist.failures = ["refused"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistAdd("p1", ["X"]));

    await expect(gk.applyAction(id)).rejects.toThrow("Too many requests");
    await gk.applyAction(id);

    expect(playlist.writes).toBe(1);
    expect(playlist.uris).toEqual(["A", "B", "X"]);
    expect(kv.get(`retiredAction:${id}`)).toMatchObject({ state: "approved" });
    await gk.revertAction(id);
    expect(playlist.uris).toEqual(["A", "B"]);
  });
});

// Playlist creates and details edits over the stubbed fetch, failing writes as in fakePlaylist.
function fakePlaylists() {
  const state = { created: [] as string[], name: "Original", failures: [] as ("lost" | "refused" | undefined)[] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (method === "GET" && pathname === "/v1/playlists/p1") {
      return Response.json({ id: "p1", name: state.name, uri: "spotify:playlist:p1", owner: { id: "user" } });
    }
    const failure = state.failures.shift();
    if (failure === "refused") return Response.json({ error: { message: "Too many requests" } }, { status: 429 });
    const body = JSON.parse(init.body as string);
    let reply: Response;
    if (method === "POST" && pathname === "/v1/me/playlists") {
      const id = `new${state.created.length + 1}`;
      state.created.push(id);
      reply = Response.json({ id, name: body.name, uri: `spotify:playlist:${id}`, owner: { id: "user" } });
    } else if (method === "PUT" && pathname === "/v1/playlists/p1") {
      if (body.name !== undefined) state.name = body.name;
      reply = new Response(null, { status: 200 });
    } else {
      throw new Error(`Unexpected ${method} ${pathname}`);
    }
    if (failure === "lost") throw new TypeError("Network connection lost.");
    return reply;
  }));
  return state;
}

describe("re-applying a playlist create or details edit whose earlier attempt is unknown", () => {
  it("won't create the playlist again after a create whose reply was lost", async () => {
    const state = fakePlaylists();
    state.failures = ["lost"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistCreate("Mix", { public: false }));

    await expect(gk.applyAction(id)).rejects.toThrow("Network connection lost.");
    await expect(gk.applyAction(id)).rejects.toThrow(/may have gone through/);

    expect(state.created).toEqual(["new1"]);
    expect(kv.get(`action:${id}`)).toMatchObject({ state: "failed" });
  });

  it("creates once on a retry after Spotify refused the first create", async () => {
    const state = fakePlaylists();
    state.failures = ["refused"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistCreate("Mix", { public: false }));

    await expect(gk.applyAction(id)).rejects.toThrow("Too many requests");
    await gk.applyAction(id);

    expect(state.created).toEqual(["new1"]);
    expect(kv.get(`retiredAction:${id}`)).toMatchObject({ state: "approved", revert: { realId: "new1" } });
  });

  it("keeps the details from before the first attempt to revert to after a rename whose reply was lost", async () => {
    const state = fakePlaylists();
    state.failures = ["lost"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistDetails("p1", { name: "Changed" }));

    await expect(gk.applyAction(id)).rejects.toThrow("Network connection lost.");
    await gk.applyAction(id);

    expect(state.name).toBe("Changed");
    expect(kv.get(`retiredAction:${id}`)).toMatchObject({ state: "approved", revert: { previous: { name: "Original" } } });
    await gk.revertAction(id);
    expect(state.name).toBe("Original");
  });

  it("keeps the first snapshot when a retry after a lost rename reply is refused", async () => {
    const state = fakePlaylists();
    state.failures = ["lost", "refused"];
    const { gk, kv } = gatekeeper();
    const id = await submitted(gk, gk.preparePlaylistDetails("p1", { name: "Changed" }));

    await expect(gk.applyAction(id)).rejects.toThrow("Network connection lost.");
    await expect(gk.applyAction(id)).rejects.toThrow("Too many requests");
    await gk.applyAction(id);

    expect(kv.get(`retiredAction:${id}`)).toMatchObject({ state: "approved", revert: { previous: { name: "Original" } } });
    await gk.revertAction(id);
    expect(state.name).toBe("Original");
  });
});
