/**
 * Geo Knowledge Graph publishing via direct SDK.
 * Creates entities using canonical Research ontology and proposes to DAO space.
 */

import type { DiscoveryPaper, ExtractedClaim } from './KfdbService.js';
import { config } from '../config/index.js';
import {
  DAO_SPACE_ADDRESS,
  DAO_SPACE_ID,
  PAPER_TYPE,
  CLAIM_TYPE,
  PERSON_TYPE,
  TOPIC_TYPE,
  PAPER_PROPS,
  CLAIM_PROPS,
} from '../utils/geo-schema-ids.js';

interface PublishResult {
  proposalId: string;
  txHash: string;
  paperEntityId: string;
  claimEntityIds: string[];
}

/**
 * Publish an approved paper + claims to the Geo knowledge graph.
 * Uses @geoprotocol/geo-sdk directly for entity creation and DAO proposal.
 */
export async function publishPaperToGeo(
  paper: DiscoveryPaper,
  claims: ExtractedClaim[],
  _publisherWallet: string,
): Promise<PublishResult> {
  // Dynamic imports to avoid bundling issues
  const { Graph, daoSpace, Account, getSmartAccountWalletClient } = await import('@geoprotocol/geo-sdk');
  const { createPublicClient, http } = await import('viem');

  const privateKey = config.geo.privateKey;
  if (!privateKey) throw new Error('GEO_PRIVATE_KEY not configured');

  const hexKey = `0x${privateKey.replace(/^0x/, '')}` as `0x${string}`;

  const smartAccountClient = await getSmartAccountWalletClient({ privateKey: hexKey });

  // Get caller space ID from wallet address
  const walletAddress = smartAccountClient.account.address;
  const { accountId, ops: accountOps } = Account.make(walletAddress);

  // Accumulate all ops
  const allOps: any[] = [...accountOps];

  // Create paper entity
  const paperResult = Graph.createEntity({
    name: paper.title,
    description: paper.abstract.slice(0, 200),
    types: [PAPER_TYPE],
    values: [
      { property: PAPER_PROPS.abstract, type: 'text', value: paper.abstract },
      { property: PAPER_PROPS.webUrl, type: 'text', value: paper.web_url },
      ...(paper.published_date ? [{ property: PAPER_PROPS.publishDate, type: 'datetime' as const, value: paper.published_date }] : []),
      ...(paper.topics.length > 0 ? [{ property: PAPER_PROPS.tags, type: 'text' as const, value: paper.topics.join(', ') }] : []),
    ],
  });
  allOps.push(...paperResult.ops);

  // Create author entities and link via relations
  const authorRelations: any[] = [];
  for (const authorName of paper.authors) {
    const authorResult = Graph.createEntity({
      name: authorName,
      types: [PERSON_TYPE],
    });
    allOps.push(...authorResult.ops);
    authorRelations.push({ toEntity: authorResult.id });
  }

  // Create topic entities and link
  const topicRelations: any[] = [];
  for (const topicName of paper.topics) {
    const topicResult = Graph.createEntity({
      name: topicName,
      types: [TOPIC_TYPE],
    });
    allOps.push(...topicResult.ops);
    topicRelations.push({ toEntity: topicResult.id });
  }

  // Create relations from paper to authors and topics
  if (authorRelations.length > 0) {
    for (const rel of authorRelations) {
      const relResult = Graph.createRelation({
        fromEntity: paperResult.id,
        toEntity: rel.toEntity,
        type: PAPER_PROPS.authors,
      });
      allOps.push(...relResult.ops);
    }
  }

  if (topicRelations.length > 0) {
    for (const rel of topicRelations) {
      const relResult = Graph.createRelation({
        fromEntity: paperResult.id,
        toEntity: rel.toEntity,
        type: PAPER_PROPS.relatedTopics,
      });
      allOps.push(...relResult.ops);
    }
  }

  // Create claim entities
  const claimEntityIds: string[] = [];
  for (const claim of claims) {
    const claimText = claim.edited_text || claim.text;

    const claimValues: any[] = [];
    if (claim.source_quote) {
      claimValues.push({ property: CLAIM_PROPS.quotes, type: 'text', value: claim.source_quote });
    }

    const claimResult = Graph.createEntity({
      name: claimText.slice(0, 500),
      types: [CLAIM_TYPE],
      values: claimValues.length > 0 ? claimValues : undefined,
    });
    allOps.push(...claimResult.ops);
    claimEntityIds.push(claimResult.id as string);

    // Link claim to paper via Sources relation
    const sourceRelResult = Graph.createRelation({
      fromEntity: claimResult.id,
      toEntity: paperResult.id,
      type: CLAIM_PROPS.sources,
    });
    allOps.push(...sourceRelResult.ops);
  }

  // Propose DAO edit
  // Need callerSpaceId — use the personal space from config or derive
  const callerSpaceId = '0xbaddbe29ee5c1764925996eafba6d00f' as `0x${string}`;

  const proposal = await daoSpace.proposeEdit({
    name: `Add paper: ${paper.title.slice(0, 80)}`,
    ops: allOps,
    author: accountId,
    daoSpaceAddress: DAO_SPACE_ADDRESS as `0x${string}`,
    callerSpaceId,
    daoSpaceId: `0x${DAO_SPACE_ID}` as `0x${string}`,
    network: 'TESTNET',
  });

  // Send the transaction
  const txHash = await smartAccountClient.sendTransaction({
    to: proposal.to,
    data: proposal.calldata,
  });

  // Wait for confirmation
  const publicClient = createPublicClient({
    transport: http('https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz'),
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    proposalId: proposal.proposalId,
    txHash,
    paperEntityId: paperResult.id as string,
    claimEntityIds,
  };
}
