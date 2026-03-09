import { githubGraphQL } from "./github-app.js";
import { detectRepo, isValidRepo } from "./issues.js";

// --- Types ---

export interface ProjectItem {
  id: string;
  title: string;
  status: string | null;
  body: string;
  fieldValueId: string | null;
  linkedIssueNumber: number | null;
  reactions: number;
}

export interface ProjectConfig {
  projectId: string;
  statusFieldId: string;
  statusOptions: Map<string, string>; // "Backlog" -> option_id
}

// --- Constants ---

const PROJECT_TITLE = "Bloom Evolution Roadmap";
const STATUS_COLUMNS = ["Backlog", "Up Next", "In Progress", "Done"] as const;
export type StatusColumn = (typeof STATUS_COLUMNS)[number];

// --- Project Discovery/Creation ---

/**
 * Find the Bloom project by title, or create it if it doesn't exist.
 * Returns null if the API calls fail (best-effort).
 */
export async function ensureProject(): Promise<ProjectConfig | null> {
  const repo = detectRepo();
  if (!repo || !isValidRepo(repo)) return null;
  const [owner] = repo.split("/");

  try {
    const existing = await findProject(owner);
    if (existing) return existing;
    return await createProject(owner);
  } catch {
    return null;
  }
}

async function findProject(
  owner: string,
): Promise<ProjectConfig | null> {
  const query = `
    query($owner: String!, $searchQuery: String!) {
      organization(login: $owner) {
        projectsV2(first: 20, query: $searchQuery) {
          nodes {
            id
            title
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Try org first, fall back to user
  let result = await githubGraphQL(query, {
    owner,
    searchQuery: PROJECT_TITLE,
  });

  if (!result.data?.organization) {
    const userQuery = query.replace("organization", "user");
    result = await githubGraphQL(userQuery, {
      owner,
      searchQuery: PROJECT_TITLE,
    });
  }

  const projects =
    (result.data as Record<string, { projectsV2?: { nodes: Record<string, unknown>[] } }>)?.organization?.projectsV2?.nodes ??
    (result.data as Record<string, { projectsV2?: { nodes: Record<string, unknown>[] } }>)?.user?.projectsV2?.nodes ??
    [];

  const project = projects.find(
    (p: Record<string, unknown>) => p.title === PROJECT_TITLE,
  );
  if (!project) return null;

  return extractProjectConfig(project as unknown as ProjectShape);
}

async function createProject(
  owner: string,
): Promise<ProjectConfig | null> {
  // Step 1: Get owner ID
  const ownerQuery = `
    query($owner: String!) {
      organization(login: $owner) { id }
    }
  `;
  let ownerResult = await githubGraphQL(ownerQuery, { owner });
  let ownerId = (ownerResult.data as Record<string, { id?: string }>)?.organization?.id;

  if (!ownerId) {
    const userQuery = `query($owner: String!) { user(login: $owner) { id } }`;
    ownerResult = await githubGraphQL(userQuery, { owner });
    ownerId = (ownerResult.data as Record<string, { id?: string }>)?.user?.id;
  }
  if (!ownerId) return null;

  // Step 2: Create project
  const createMutation = `
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id }
      }
    }
  `;
  const createResult = await githubGraphQL(createMutation, {
    ownerId,
    title: PROJECT_TITLE,
  });
  const projectId = (createResult.data as Record<string, { projectV2?: { id: string } }>)?.createProjectV2?.projectV2?.id;
  if (!projectId) return null;

  // Step 3: Fetch the auto-created Status field
  const fieldsQuery = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  `;
  const fieldsResult = await githubGraphQL(fieldsQuery, { projectId });
  const fields =
    ((fieldsResult.data as Record<string, { fields?: { nodes: FieldNode[] } }>)?.node?.fields?.nodes) ?? [];
  const statusField = fields.find(
    (f: FieldNode) => f.name === "Status",
  );
  if (!statusField) return null;

  return extractProjectConfig({
    id: projectId,
    fields: { nodes: fields },
  });
}

export interface FieldNode {
  id?: string;
  name?: string;
  options?: Array<{ id: string; name: string }>;
}

export interface ProjectShape {
  id: string;
  fields?: { nodes: FieldNode[] };
}

export function extractProjectConfig(project: ProjectShape): ProjectConfig | null {
  const fields = project.fields?.nodes ?? [];
  const statusField = fields.find((f) => f.name === "Status" && f.id);
  if (!statusField?.id || !statusField.options) return null;

  const statusOptions = new Map<string, string>();
  for (const opt of statusField.options) {
    statusOptions.set(opt.name, opt.id);
  }

  return {
    projectId: project.id,
    statusFieldId: statusField.id,
    statusOptions,
  };
}

// --- Item CRUD ---

/**
 * Resolve a GitHub issue number to its GraphQL node ID.
 */
export async function getIssueNodeId(
  repo: string,
  issueNumber: number,
): Promise<string | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;

  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) { id }
      }
    }
  `;

  try {
    const result = await githubGraphQL(query, { owner, name, number: issueNumber });
    return (result.data as Record<string, { issue?: { id: string } }>)?.repository?.issue?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a real GitHub issue to the project board (linked, not a draft).
 * Falls back to addDraftItem if the issue can't be linked.
 */
export async function addLinkedItem(
  config: ProjectConfig,
  repo: string,
  issueNumber: number,
  title: string,
  body: string,
  status: StatusColumn = "Backlog",
): Promise<string | null> {
  const nodeId = await getIssueNodeId(repo, issueNumber);
  if (!nodeId) {
    // Fall back to draft item
    return addDraftItem(config, `#${issueNumber}: ${title}`, body, status);
  }

  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `;

  try {
    const result = await githubGraphQL(mutation, {
      projectId: config.projectId,
      contentId: nodeId,
    });
    const itemId = (result.data as Record<string, { item?: { id: string } }>)?.addProjectV2ItemById?.item?.id;
    if (!itemId) return addDraftItem(config, `#${issueNumber}: ${title}`, body, status);

    await updateItemStatus(config, itemId, status);
    return itemId;
  } catch {
    return addDraftItem(config, `#${issueNumber}: ${title}`, body, status);
  }
}

/**
 * Get all items from the project with their status.
 */
export async function getProjectItems(
  config: ProjectConfig,
): Promise<ProjectItem[]> {
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 50) {
            nodes {
              id
              fieldValues(first: 10) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    id
                    name
                    field { ... on ProjectV2SingleSelectField { id } }
                  }
                }
              }
              content {
                ... on DraftIssue {
                  title
                  body
                }
                ... on Issue {
                  title
                  body
                  number
                  reactions { totalCount }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await githubGraphQL(query, { projectId: config.projectId });
  const items =
    ((result.data as Record<string, { items?: { nodes: Record<string, unknown>[] } }>)?.node?.items?.nodes) ?? [];

  return items.map((item: Record<string, unknown>) => {
    const content = item.content as Record<string, unknown> | null;
    const fieldValues = (
      item.fieldValues as { nodes: Array<Record<string, unknown>> }
    )?.nodes ?? [];
    const statusValue = fieldValues.find(
      (fv: Record<string, unknown>) =>
        (fv.field as { id?: string })?.id === config.statusFieldId,
    );

    return {
      id: item.id as string,
      title: (content?.title as string) ?? "",
      body: (content?.body as string) ?? "",
      status: (statusValue?.name as string) ?? null,
      fieldValueId: (statusValue?.id as string) ?? null,
      linkedIssueNumber: (content?.number as number) ?? null,
      reactions:
        (content?.reactions as { totalCount: number })?.totalCount ?? 0,
    };
  });
}

/**
 * Add a draft issue to the project.
 */
export async function addDraftItem(
  config: ProjectConfig,
  title: string,
  body: string,
  status: StatusColumn = "Backlog",
): Promise<string | null> {
  const mutation = `
    mutation($projectId: ID!, $title: String!, $body: String) {
      addProjectV2DraftIssue(input: {
        projectId: $projectId,
        title: $title,
        body: $body
      }) {
        projectItem { id }
      }
    }
  `;

  const result = await githubGraphQL(mutation, {
    projectId: config.projectId,
    title,
    body,
  });
  const itemId = (result.data as Record<string, { projectItem?: { id: string } }>)?.addProjectV2DraftIssue?.projectItem?.id;
  if (!itemId) return null;

  await updateItemStatus(config, itemId, status);
  return itemId;
}

/**
 * Update the status of a project item.
 */
export async function updateItemStatus(
  config: ProjectConfig,
  itemId: string,
  status: StatusColumn,
): Promise<boolean> {
  const optionId = config.statusOptions.get(status);
  if (!optionId) return false;

  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `;

  const result = await githubGraphQL(mutation, {
    projectId: config.projectId,
    itemId,
    fieldId: config.statusFieldId,
    optionId,
  });

  return !!result.data?.updateProjectV2ItemFieldValue;
}

// --- Planning Logic ---

/**
 * Pick the highest-priority item to work on this cycle.
 * Priority: "Up Next" first (by reactions), then "Backlog" (by reactions).
 */
export function pickNextItem(items: ProjectItem[]): ProjectItem | null {
  const upNext = items
    .filter((i) => i.status === "Up Next")
    .sort((a, b) => b.reactions - a.reactions);
  if (upNext.length > 0) return upNext[0];

  const backlog = items
    .filter((i) => i.status === "Backlog")
    .sort((a, b) => b.reactions - a.reactions);
  return backlog.length > 0 ? backlog[0] : null;
}

/**
 * Format project items for inclusion in the assessment prompt.
 */
export function formatPlanningContext(
  items: ProjectItem[],
  currentItem: ProjectItem | null,
  maxChars: number = 1500,
): string {
  if (items.length === 0 && !currentItem) return "";

  const lines: string[] = ["## Evolution Roadmap"];

  if (currentItem) {
    lines.push(`\n**Current focus**: ${currentItem.title}`);
    if (currentItem.body) {
      lines.push(currentItem.body.slice(0, 200));
    }
  }

  for (const status of STATUS_COLUMNS) {
    const statusItems = items.filter((i) => i.status === status);
    if (statusItems.length === 0) continue;

    lines.push(`\n### ${status}`);
    for (const item of statusItems.slice(0, 5)) {
      const reactions =
        item.reactions > 0 ? ` (${item.reactions} reactions)` : "";
      const issue = item.linkedIssueNumber
        ? ` [#${item.linkedIssueNumber}]`
        : "";
      lines.push(`- ${item.title}${issue}${reactions}`);
    }
  }

  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "\n..." : result;
}
