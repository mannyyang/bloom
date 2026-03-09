import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module
vi.mock("../src/github-app.js", () => ({
  githubGraphQL: vi.fn(),
}));

vi.mock("../src/issues.js", () => ({
  detectRepo: vi.fn(),
  isValidRepo: vi.fn(),
}));

import { ensureProject, getProjectItems, addDraftItem, updateItemStatus, type ProjectConfig } from "../src/planning.js";
import { githubGraphQL } from "../src/github-app.js";
import { detectRepo, isValidRepo } from "../src/issues.js";

const mockGraphQL = vi.mocked(githubGraphQL);
const mockDetectRepo = vi.mocked(detectRepo);
const mockIsValidRepo = vi.mocked(isValidRepo);

function makeConfig(): ProjectConfig {
  return {
    projectId: "proj-1",
    statusFieldId: "field-1",
    statusOptions: new Map([
      ["Backlog", "opt-1"],
      ["Up Next", "opt-2"],
      ["In Progress", "opt-3"],
      ["Done", "opt-4"],
    ]),
  };
}

// GraphQL response for a project with a Status field
function orgProjectResponse() {
  return {
    data: {
      organization: {
        projectsV2: {
          nodes: [
            {
              id: "proj-found",
              title: "Bloom Evolution Roadmap",
              fields: {
                nodes: [
                  { id: "f1", name: "Title" },
                  {
                    id: "f-status",
                    name: "Status",
                    options: [
                      { id: "s1", name: "Backlog" },
                      { id: "s2", name: "Done" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

describe("ensureProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when detectRepo returns null", async () => {
    mockDetectRepo.mockReturnValue(null);
    expect(await ensureProject()).toBeNull();
  });

  it("returns null when isValidRepo returns false", async () => {
    mockDetectRepo.mockReturnValue("owner/repo");
    mockIsValidRepo.mockReturnValue(false);
    expect(await ensureProject()).toBeNull();
  });

  it("finds existing project via organization query", async () => {
    mockDetectRepo.mockReturnValue("myorg/bloom");
    mockIsValidRepo.mockReturnValue(true);
    mockGraphQL.mockResolvedValueOnce(orgProjectResponse());

    const result = await ensureProject();
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj-found");
    expect(result!.statusFieldId).toBe("f-status");
    expect(result!.statusOptions.get("Backlog")).toBe("s1");
  });

  it("falls back to user query when organization returns null", async () => {
    mockDetectRepo.mockReturnValue("myuser/bloom");
    mockIsValidRepo.mockReturnValue(true);

    // First call (org query) returns no data
    mockGraphQL.mockResolvedValueOnce({ data: {} });
    // Second call (user fallback) returns project
    mockGraphQL.mockResolvedValueOnce({
      data: {
        user: {
          projectsV2: {
            nodes: [
              {
                id: "proj-user",
                title: "Bloom Evolution Roadmap",
                fields: {
                  nodes: [
                    {
                      id: "f-status-u",
                      name: "Status",
                      options: [{ id: "su1", name: "Backlog" }],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const result = await ensureProject();
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj-user");
    // Verify the second call replaced "organization" with "user"
    const secondCallQuery = mockGraphQL.mock.calls[1][0];
    expect(secondCallQuery).toContain("user");
    expect(secondCallQuery).not.toContain("organization");
  });

  it("returns null when project is not found and creation fails", async () => {
    mockDetectRepo.mockReturnValue("myorg/bloom");
    mockIsValidRepo.mockReturnValue(true);

    // findProject returns empty nodes
    mockGraphQL.mockResolvedValueOnce({
      data: { organization: { projectsV2: { nodes: [] } } },
    });
    // createProject: get owner ID
    mockGraphQL.mockResolvedValueOnce({
      data: { organization: { id: "owner-id" } },
    });
    // createProject: create mutation returns null
    mockGraphQL.mockResolvedValueOnce({
      data: { createProjectV2: { projectV2: null } },
    });

    const result = await ensureProject();
    expect(result).toBeNull();
  });

  it("returns null when GraphQL throws an error", async () => {
    mockDetectRepo.mockReturnValue("myorg/bloom");
    mockIsValidRepo.mockReturnValue(true);
    mockGraphQL.mockRejectedValueOnce(new Error("Network error"));

    const result = await ensureProject();
    expect(result).toBeNull();
  });
});

describe("getProjectItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed items from GraphQL response", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: {
        node: {
          items: {
            nodes: [
              {
                id: "item-1",
                content: {
                  title: "Fix bug",
                  body: "Description",
                  number: 42,
                  reactions: { totalCount: 5 },
                },
                fieldValues: {
                  nodes: [
                    {
                      id: "fv-1",
                      name: "Backlog",
                      field: { id: "field-1" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const items = await getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "item-1",
      title: "Fix bug",
      body: "Description",
      status: "Backlog",
      fieldValueId: "fv-1",
      linkedIssueNumber: 42,
      reactions: 5,
    });
  });

  it("returns empty array when no items exist", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: { node: { items: { nodes: [] } } },
    });

    const items = await getProjectItems(config);
    expect(items).toEqual([]);
  });

  it("handles items with null content (draft issues without fields)", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: {
        node: {
          items: {
            nodes: [
              {
                id: "item-2",
                content: null,
                fieldValues: { nodes: [] },
              },
            ],
          },
        },
      },
    });

    const items = await getProjectItems(config);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("");
    expect(items[0].body).toBe("");
    expect(items[0].status).toBeNull();
    expect(items[0].linkedIssueNumber).toBeNull();
    expect(items[0].reactions).toBe(0);
  });

  it("returns empty array when node data is missing", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({ data: {} });

    const items = await getProjectItems(config);
    expect(items).toEqual([]);
  });
});

describe("addDraftItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a draft item and sets its status", async () => {
    const config = makeConfig();
    // First call: create draft
    mockGraphQL.mockResolvedValueOnce({
      data: {
        addProjectV2DraftIssue: { projectItem: { id: "new-item-1" } },
      },
    });
    // Second call: updateItemStatus
    mockGraphQL.mockResolvedValueOnce({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "new-item-1" } } },
    });

    const itemId = await addDraftItem(config, "New feature", "Details", "Up Next");
    expect(itemId).toBe("new-item-1");
    // Verify status update was called
    expect(mockGraphQL).toHaveBeenCalledTimes(2);
  });

  it("returns null when draft creation fails", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: { addProjectV2DraftIssue: { projectItem: null } },
    });

    const itemId = await addDraftItem(config, "Title", "Body");
    expect(itemId).toBeNull();
    // Should not attempt status update
    expect(mockGraphQL).toHaveBeenCalledTimes(1);
  });

  it("defaults to Backlog status when not specified", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: {
        addProjectV2DraftIssue: { projectItem: { id: "item-default" } },
      },
    });
    mockGraphQL.mockResolvedValueOnce({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-default" } } },
    });

    await addDraftItem(config, "Title", "Body");
    // Second call should use Backlog option ID
    const statusCallVars = mockGraphQL.mock.calls[1][1];
    expect(statusCallVars).toEqual(
      expect.objectContaining({ optionId: "opt-1" }),
    );
  });
});

describe("updateItemStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true on successful status update", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-1" } } },
    });

    const result = await updateItemStatus(config, "item-1", "In Progress");
    expect(result).toBe(true);
    const vars = mockGraphQL.mock.calls[0][1];
    expect(vars).toEqual(
      expect.objectContaining({
        projectId: "proj-1",
        itemId: "item-1",
        fieldId: "field-1",
        optionId: "opt-3",
      }),
    );
  });

  it("returns false when status option is not found", async () => {
    const config: ProjectConfig = {
      projectId: "proj-1",
      statusFieldId: "field-1",
      statusOptions: new Map(), // empty - no options
    };

    const result = await updateItemStatus(config, "item-1", "Backlog");
    expect(result).toBe(false);
    expect(mockGraphQL).not.toHaveBeenCalled();
  });

  it("returns false when GraphQL returns null data", async () => {
    const config = makeConfig();
    mockGraphQL.mockResolvedValueOnce({
      data: { updateProjectV2ItemFieldValue: null },
    });

    const result = await updateItemStatus(config, "item-1", "Done");
    expect(result).toBe(false);
  });
});
