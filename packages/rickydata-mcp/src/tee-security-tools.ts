/**
 * TEE Security Verification MCP Tools
 *
 * Exposes the rickydata platform's TEE attestation and security verification
 * endpoints as structured MCP tools. These tools call public, unauthenticated
 * health and attestation endpoints on both the MCP Gateway and the Agent
 * Gateway, returning parsed JSON suitable for downstream reasoning by an
 * agent.
 *
 * Tools:
 *   - tee_verify             — One-click verification with verdict (pass/warn/fail)
 *   - tee_get_attestation    — Full TEE attestation report (AMD SEV-SNP, VCEK chain)
 *   - tee_get_build_info     — Build provenance, code hash, git commit
 *   - tee_get_attestation_bundle — Self-contained offline verification bundle
 *   - tee_get_encryption_model   — Public encryption architecture description
 *   - tee_health_mcp_gateway — MCP gateway /health (security posture, secret encryption)
 *   - tee_health_agent_gateway — Agent gateway /health (signing key material, cross-gateway trust)
 *   - tee_get_jwks           — ES256 public key for cross-gateway JWT verification
 *
 * No authentication is required for any of these endpoints — they are designed
 * to be public so that any third party can independently verify the platform.
 */

const DEFAULT_MCP_GATEWAY_URL = "https://mcp.rickydata.org";
const DEFAULT_AGENT_GATEWAY_URL = "https://agents.rickydata.org";

/** Tool names */
export const TEE_VERIFY = "tee_verify";
export const TEE_GET_ATTESTATION = "tee_get_attestation";
export const TEE_GET_BUILD_INFO = "tee_get_build_info";
export const TEE_GET_ATTESTATION_BUNDLE = "tee_get_attestation_bundle";
export const TEE_GET_ENCRYPTION_MODEL = "tee_get_encryption_model";
export const TEE_HEALTH_MCP_GATEWAY = "tee_health_mcp_gateway";
export const TEE_HEALTH_AGENT_GATEWAY = "tee_health_agent_gateway";
export const TEE_GET_JWKS = "tee_get_jwks";

export const TEE_SECURITY_TOOL_NAMES = new Set([
  TEE_VERIFY,
  TEE_GET_ATTESTATION,
  TEE_GET_BUILD_INFO,
  TEE_GET_ATTESTATION_BUNDLE,
  TEE_GET_ENCRYPTION_MODEL,
  TEE_HEALTH_MCP_GATEWAY,
  TEE_HEALTH_AGENT_GATEWAY,
  TEE_GET_JWKS,
]);

interface TeeSecurityToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface TeeSecurityToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Returns the definitions of all TEE security verification tools (for tools/list).
 */
export function getTeeSecurityToolDefinitions(): TeeSecurityToolDef[] {
  const optionalGatewayOverride = {
    type: "object" as const,
    properties: {
      mcp_gateway_url: {
        type: "string",
        description:
          "Optional override for the MCP gateway base URL (default: https://mcp.rickydata.org). " +
          "Use only when verifying a non-production deployment.",
      },
    },
  };

  const optionalAgentOverride = {
    type: "object" as const,
    properties: {
      agent_gateway_url: {
        type: "string",
        description:
          "Optional override for the agent gateway base URL (default: https://agents.rickydata.org). " +
          "Use only when verifying a non-production deployment.",
      },
    },
  };

  return [
    {
      name: TEE_VERIFY,
      description:
        "Run a one-click verification of the MCP Gateway TEE deployment. Returns a verdict " +
        "(pass/warn/fail) with details on TEE enablement, code hash matching, attestation freshness, " +
        "and any warnings. This is the FIRST tool to call when asked 'is the gateway working' or " +
        "'verify the platform'. Equivalent to: curl https://mcp.rickydata.org/api/verify",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_GET_ATTESTATION,
      description:
        "Fetch the full TEE attestation report from the MCP Gateway. Returns the AMD SEV-SNP " +
        "attestation report, VCEK certificate chain, PCR values, and report data. Use this when " +
        "the user asks for the raw attestation data, the SNP report, or wants to verify the " +
        "certificate chain. Equivalent to: curl https://mcp.rickydata.org/api/attestation",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_GET_BUILD_INFO,
      description:
        "Fetch build provenance and code hash from the MCP Gateway. Returns the git commit hash, " +
        "build timestamp, code hash, and dirty flag. Use this to confirm what version of the code " +
        "is currently running, or to compare against a known-good build. Equivalent to: " +
        "curl https://mcp.rickydata.org/api/attestation/build-info",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_GET_ATTESTATION_BUNDLE,
      description:
        "Fetch a self-contained offline verification bundle from the MCP Gateway. Includes the " +
        "attestation report, certificate chain, build info, and a bash script that users can run " +
        "offline to independently verify the entire trust chain. Use this when the user wants to " +
        "audit the platform without trusting the gateway itself. Equivalent to: " +
        "curl https://mcp.rickydata.org/api/attestation/bundle",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_GET_ENCRYPTION_MODEL,
      description:
        "Fetch the public encryption architecture description from the MCP Gateway. Returns a " +
        "structured description of the secret encryption model (HKDF + sign-to-derive), key " +
        "storage, and TEE binding. Use this to explain HOW user secrets are protected, including " +
        "which fallback paths exist. Equivalent to: curl https://mcp.rickydata.org/api/attestation/encryption-model",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_HEALTH_MCP_GATEWAY,
      description:
        "Fetch the MCP Gateway /health endpoint. Returns gateway status, security posture " +
        "(signing key material, secret encryption labels), cross-gateway trust state, active " +
        "server count, and KFDB sync status. Use this for a quick overall health check or when " +
        "the user asks 'is X running'. Equivalent to: curl https://mcp.rickydata.org/health",
      inputSchema: optionalGatewayOverride,
    },
    {
      name: TEE_HEALTH_AGENT_GATEWAY,
      description:
        "Fetch the Agent Gateway /health endpoint. Returns gateway status, security posture " +
        "(signing key material — must be 'tpm_pcr' for healthy state, legacy fallback count), " +
        "cross-gateway trust state, agent count, skill count, and active sessions. Use this when " +
        "verifying the agent gateway specifically. Equivalent to: curl https://agents.rickydata.org/health",
      inputSchema: optionalAgentOverride,
    },
    {
      name: TEE_GET_JWKS,
      description:
        "Fetch the ES256 JWKS public key from the Agent Gateway. Returns the JSON Web Key Set " +
        "used by the MCP Gateway to verify Agent Gateway-signed JWTs (cross-gateway ES256 trust). " +
        "Use this to verify the kid (key id), key type (must be EC), curve (P-256), and to confirm " +
        "the public key has not changed unexpectedly. Equivalent to: " +
        "curl https://agents.rickydata.org/.well-known/jwks.json",
      inputSchema: optionalAgentOverride,
    },
  ];
}

/**
 * Returns true if the tool name belongs to the TEE security tool set.
 */
export function isTeeSecurityTool(toolName: string): boolean {
  return TEE_SECURITY_TOOL_NAMES.has(toolName);
}

/**
 * Handle a TEE security tool call. Fetches the appropriate public endpoint
 * and returns a parsed JSON result. No authentication required.
 */
export async function handleTeeSecurityTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<TeeSecurityToolResult> {
  const mcpGatewayUrl = (args.mcp_gateway_url as string) || DEFAULT_MCP_GATEWAY_URL;
  const agentGatewayUrl = (args.agent_gateway_url as string) || DEFAULT_AGENT_GATEWAY_URL;

  try {
    switch (toolName) {
      case TEE_VERIFY:
        return await fetchAndReturn(`${mcpGatewayUrl}/api/verify`, "tee_verify");
      case TEE_GET_ATTESTATION:
        return await fetchAndReturn(`${mcpGatewayUrl}/api/attestation`, "tee_get_attestation");
      case TEE_GET_BUILD_INFO:
        return await fetchAndReturn(
          `${mcpGatewayUrl}/api/attestation/build-info`,
          "tee_get_build_info",
        );
      case TEE_GET_ATTESTATION_BUNDLE:
        return await fetchAndReturn(
          `${mcpGatewayUrl}/api/attestation/bundle`,
          "tee_get_attestation_bundle",
        );
      case TEE_GET_ENCRYPTION_MODEL:
        return await fetchAndReturn(
          `${mcpGatewayUrl}/api/attestation/encryption-model`,
          "tee_get_encryption_model",
        );
      case TEE_HEALTH_MCP_GATEWAY:
        return await fetchAndReturn(`${mcpGatewayUrl}/health`, "tee_health_mcp_gateway");
      case TEE_HEALTH_AGENT_GATEWAY:
        return await fetchAndReturn(`${agentGatewayUrl}/health`, "tee_health_agent_gateway");
      case TEE_GET_JWKS:
        return await fetchAndReturn(
          `${agentGatewayUrl}/.well-known/jwks.json`,
          "tee_get_jwks",
        );
      default:
        return {
          content: [
            { type: "text", text: `Unknown TEE security tool: ${toolName}` },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `TEE security tool error: ${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Fetch a public endpoint and return its body as a JSON-formatted MCP result.
 * Includes the source URL in the response so the model can cite it.
 */
async function fetchAndReturn(
  url: string,
  toolName: string,
): Promise<TeeSecurityToolResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              tool: toolName,
              source_url: url,
              success: false,
              error: `Fetch failed: ${(err as Error).message}`,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  clearTimeout(timeoutId);

  const status = res.status;
  const bodyText = await res.text();

  if (!res.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              tool: toolName,
              source_url: url,
              success: false,
              status,
              error: bodyText.slice(0, 2000),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  // Parse JSON if possible; fall back to raw text otherwise.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = { raw: bodyText.slice(0, 5000) };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            tool: toolName,
            source_url: url,
            success: true,
            status,
            data: parsed,
          },
          null,
          2,
        ),
      },
    ],
  };
}
