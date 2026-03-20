import { config } from '../config/index.js';
import { DAO_SPACE_ID, PAPER_TYPE, CLAIM_TYPE, toDashedUUID } from '../utils/geo-schema-ids.js';

const GRAPHQL_URL = config.geo.graphqlUrl;

interface GqlResponse {
  data?: any;
  errors?: Array<{ message: string }>;
}

async function gqlQuery(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  const json: GqlResponse = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

export interface GeoEntity {
  id: string;
  name: string;
  description?: string;
  types: string[];
  properties: Record<string, string>;
  relations?: Record<string, Array<{ id: string; name: string }>>;
}

/**
 * List published papers from the Geo knowledge graph (DAO space).
 */
export async function listPublishedPapers(limit = 50): Promise<GeoEntity[]> {
  const data = await gqlQuery(`
    query ListPapers($spaceId: UUID!, $typeId: UUID!, $first: Int) {
      entitiesConnection(
        spaceId: $spaceId
        typeId: $typeId
        first: $first
      ) {
        edges {
          node {
            id
            name
            description
            types { id name }
          }
        }
      }
    }
  `, {
    spaceId: toDashedUUID(DAO_SPACE_ID),
    typeId: toDashedUUID(PAPER_TYPE),
    first: limit,
  });

  return (data.entitiesConnection?.edges || []).map((edge: any) => ({
    id: edge.node.id,
    name: edge.node.name || '',
    description: edge.node.description || '',
    types: (edge.node.types || []).map((t: any) => t.name),
    properties: {},
  }));
}

/**
 * Get a single entity by ID from the DAO space.
 */
export async function getGeoEntity(entityId: string): Promise<GeoEntity | null> {
  const data = await gqlQuery(`
    query GetEntity($id: UUID!) {
      entity(id: $id) {
        id
        name
        description
        types { id name }
        valuesList {
          propertyEntity { id name }
          text
        }
        relationsList {
          typeEntity { id name }
          toEntity { id name }
        }
      }
    }
  `, { id: toDashedUUID(entityId) });

  if (!data.entity) return null;

  const resolvedId = data.entity.id;
  const resolvedName = data.entity.name || '';
  const properties: Record<string, string> = {};
  const relations: Record<string, Array<{ id: string; name: string }>> = {};

  // Text/scalar values from valuesList
  for (const value of data.entity.valuesList || []) {
    const key = value.propertyEntity?.name || value.propertyEntity?.id;
    if (!key || !value.text) continue;
    // Keep the longer value if there are duplicates (e.g., truncated vs full text)
    if (!properties[key] || value.text.length > properties[key].length) {
      properties[key] = value.text;
    }
  }

  // Entity relations from relationsList (Authors, Topics, Sources, etc.)
  for (const rel of data.entity.relationsList || []) {
    const key = rel.typeEntity?.name;
    const target = rel.toEntity;
    if (!key || !target?.id || !target?.name) continue;
    // Skip "Types" relation — already in entity.types
    if (key === 'Types') continue;
    if (!relations[key]) relations[key] = [];
    if (!relations[key].some(r => r.id === target.id)) {
      relations[key].push({ id: target.id, name: target.name });
    }
  }

  return {
    id: resolvedId,
    name: resolvedName,
    description: data.entity.description || '',
    types: (data.entity.types || []).map((t: any) => t.name),
    properties,
    relations,
  };
}

/**
 * Get claims that reference a given paper entity via the Sources relation.
 */
export async function listClaimsForPaperEntity(paperEntityId: string, limit = 50): Promise<GeoEntity[]> {
  const allClaims = await listClaimsForPaper(limit);
  const normalizedPaperId = paperEntityId.replace(/-/g, '');

  const claimsForPaper: GeoEntity[] = [];
  for (const claim of allClaims) {
    try {
      const detailed = await getGeoEntity(claim.id);
      if (!detailed) continue;
      // Check if the claim references this paper via Sources relation or properties
      const refsThisPaper =
        (detailed.relations?.Sources || []).some(r =>
          r.id.replace(/-/g, '') === normalizedPaperId
        ) ||
        Object.values(detailed.properties).some(v =>
          v.replace(/-/g, '').includes(normalizedPaperId)
        ) ||
        Object.values(detailed.relations || {}).some(refs =>
          refs.some(r => r.id.replace(/-/g, '') === normalizedPaperId)
        );
      if (refsThisPaper) {
        claimsForPaper.push(detailed);
      }
    } catch {
      // Skip claims we can't fetch details for
    }
  }
  return claimsForPaper;
}

/**
 * Resolve a list of Geo entity IDs to their names.
 * Returns a map of dashless ID -> entity name. Silently skips failures.
 */
export async function resolveEntityNames(entityIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(
    entityIds.map(async (id) => {
      try {
        const entity = await getGeoEntity(id);
        if (entity?.name) {
          result.set(id.replace(/-/g, ''), entity.name);
        }
      } catch {
        // Skip unresolvable entities
      }
    })
  );
  return result;
}

/**
 * Check if a string looks like a Geo entity ID (32-char hex).
 */
export function looksLikeEntityId(s: string): boolean {
  return /^[0-9a-f]{32}$/i.test(s.replace(/-/g, ''));
}

/**
 * List claims for a paper entity from Geo.
 */
export async function listClaimsForPaper(limit = 50): Promise<GeoEntity[]> {
  const data = await gqlQuery(`
    query ListClaims($spaceId: UUID!, $typeId: UUID!, $first: Int) {
      entitiesConnection(
        spaceId: $spaceId
        typeId: $typeId
        first: $first
      ) {
        edges {
          node {
            id
            name
            description
            types { id name }
          }
        }
      }
    }
  `, {
    spaceId: toDashedUUID(DAO_SPACE_ID),
    typeId: toDashedUUID(CLAIM_TYPE),
    first: limit,
  });

  return (data.entitiesConnection?.edges || []).map((edge: any) => ({
    id: edge.node.id,
    name: edge.node.name || '',
    description: edge.node.description || '',
    types: (edge.node.types || []).map((t: any) => t.name),
    properties: {},
  }));
}
