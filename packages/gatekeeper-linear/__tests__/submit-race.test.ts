// An auto-approved action can be applied while enqueue is still awaiting the overseer's reply.
// These drive the real gatekeeper class with an approval queue that applies before it replies.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  RpcStub: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/linear-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/linear-workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-team-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-issue-configurator-ui.txt", () => ({ default: "" }));

const { LinearGatekeeperImpl } = await import("../src/linear");

function gatekeeper() {
  const kv = new Map<string, unknown>();
  const account = { getAccessToken: async () => "token", noteCredentialsExpired: async () => {} };
  const ctx = {
    props: { userObjectId: "user", workspaceUrlKey: "acme" },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } },
    storage: {
      kv: {
        get: (key: string) => structuredClone(kv.get(key)),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)),
      },
    },
  };
  return { gk: new LinearGatekeeperImpl(ctx as never, {} as never), kv };
}

const archive = { kind: "archive", issueRef: "issue-1", archived: true, title: "Archive ENG-1" } as const;
const description = { title: "Archive ENG-1", description: "Archive the issue.", implementsRevert: true };

afterEach(() => vi.unstubAllGlobals());

describe("enqueue when the action is applied before the reply", () => {
  it("keeps an action whose apply failed before the reply was lost, for a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 400 })));
    const { gk, kv } = gatekeeper();
    const queue = { submitAction: async (id: number) => {
      await gk.applyAction(id).catch(() => {});
      throw new Error("Network connection lost.");
    } } as never;
    await expect(gk.enqueue(queue, archive as never, description as never)).resolves.toBeUndefined();
    expect(kv.get("action:1")).toMatchObject({ status: "pending", applyStarted: true });
  });

  it("does not write again when an apply already ran is delivered again", async () => {
    const fetch = vi.fn(async () => Response.json({ data: { issueArchive: { success: true } } }));
    vi.stubGlobal("fetch", fetch);
    const { gk } = gatekeeper();
    const queue = { submitAction: async () => {} } as never;
    await gk.enqueue(queue, archive as never, description as never);
    await gk.applyAction(1);
    const calls = fetch.mock.calls.length;
    await gk.applyAction(1);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("still drops the record and fails when the submit fails without applying", async () => {
    const { gk, kv } = gatekeeper();
    const queue = { submitAction: async () => { throw new Error("queue gone"); } } as never;
    await expect(gk.enqueue(queue, archive as never, description as never)).rejects.toThrow("queue gone");
    expect(kv.has("action:1")).toBe(false);
  });
});

// A fake Linear GraphQL endpoint holding the issues and comments it has created, by id. While
// `loseNextReply` is set, the next create commits and then the connection drops.
function fakeLinear() {
  const issues = new Map<string, unknown>();
  const comments = new Map<string, unknown>();
  const creates: Array<{ id?: string }> = [];
  const state = { loseNextReply: false };
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string) as
      { query: string; variables: { input: { id?: string }; filter: { id: { eq: string } }; id: string } };
    const create = (store: Map<string, unknown>, field: string, entity: string) => {
      const id = variables.input.id ?? crypto.randomUUID();
      creates.push(variables.input);
      store.set(id, variables.input);
      if (state.loseNextReply) {
        state.loseNextReply = false;
        throw new TypeError("Network connection lost.");
      }
      return Response.json({ data: { [field]: { success: true, [entity]: { id } } } });
    };
    const lookup = (store: Map<string, unknown>, field: string) => Response.json({ data: {
      [field]: { nodes: store.has(variables.filter.id.eq) ? [{ id: variables.filter.id.eq }] : [],
                 pageInfo: { hasNextPage: false, endCursor: null } } } });
    const remove = (store: Map<string, unknown>, field: string) => {
      store.delete(variables.id);
      return Response.json({ data: { [field]: { success: true } } });
    };
    if (query.includes("issueCreate(")) return create(issues, "issueCreate", "issue");
    if (query.includes("commentCreate(")) return create(comments, "commentCreate", "comment");
    if (query.includes("issues(")) return lookup(issues, "issues");
    if (query.includes("comments(")) return lookup(comments, "comments");
    if (query.includes("issueDelete(")) return remove(issues, "issueDelete");
    if (query.includes("commentDelete(")) return remove(comments, "commentDelete");
    throw new Error(`Unexpected query: ${query}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { issues, comments, creates, state };
}

const createIssue = {
  kind: "createIssue", input: { teamId: "team-1", title: "Bug" }, provisionalId: "~1",
  synthetic: { id: "~1", assignee: null }, title: 'Create issue "Bug"',
} as const;
const postComment = {
  kind: "postComment", issueRef: "issue-1", body: "Done.", synthetic: { id: "~comment:1" }, title: "Comment on ENG-1",
} as const;
const createDescription = { title: 'Create issue "Bug"', description: "Create an issue.", implementsRevert: true };
const noReply = { submitAction: async () => {} } as never;

describe("a create whose reply was lost", () => {
  it("sends the id it records as the created issue", async () => {
    const linear = fakeLinear();
    const { gk, kv } = gatekeeper();
    await gk.enqueue(noReply, createIssue as never, createDescription as never);
    await gk.applyAction(1);
    const [sent] = linear.creates;
    expect(sent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(kv.get("action:1")).toMatchObject({ status: "applied", createdIssueId: sent.id });
    expect(kv.get("provisional:~1")).toBe(sent.id);
  });

  it("finds the issue the lost attempt made instead of creating a second, and reverts that one", async () => {
    const linear = fakeLinear();
    const { gk, kv } = gatekeeper();
    await gk.enqueue(noReply, createIssue as never, createDescription as never);
    linear.state.loseNextReply = true;
    await expect(gk.applyAction(1)).rejects.toThrow("Network connection lost.");
    expect(kv.get("action:1")).toMatchObject({ status: "pending", applyStarted: true });

    await gk.applyAction(1);
    expect(linear.creates).toHaveLength(1);
    expect([...linear.issues.keys()]).toEqual([linear.creates[0].id]);
    expect(kv.get("action:1")).toMatchObject({ status: "applied", createdIssueId: linear.creates[0].id });
    expect(kv.get("provisional:~1")).toBe(linear.creates[0].id);

    await gk.revertAction(1);
    expect(linear.issues.size).toBe(0);
  });

  it("finds the comment the lost attempt posted instead of posting it again", async () => {
    const linear = fakeLinear();
    const { gk, kv } = gatekeeper();
    await gk.enqueue(noReply, postComment as never, { ...createDescription, title: "Comment on ENG-1" } as never);
    linear.state.loseNextReply = true;
    await expect(gk.applyAction(1)).rejects.toThrow("Network connection lost.");

    await gk.applyAction(1);
    expect(linear.creates).toHaveLength(1);
    expect([...linear.comments.keys()]).toEqual([linear.creates[0].id]);
    expect(kv.get("action:1")).toMatchObject({ status: "applied", createdCommentId: linear.creates[0].id });
  });
});
