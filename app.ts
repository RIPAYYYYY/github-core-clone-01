// app.ts: the forge's HTTP server. One process serves the four surfaces from one store: git smart HTTP
// at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp. Every reply
// carries a non-empty X-GitHub-Request-Id; every surface but /healthz requires the trial's bearer
// token; unknown routes answer a JSON 404, never HTML.

import { createServer, type Server } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextRequestId, readReq, sendError, sendJson, tokenOk } from './http.ts';

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', nextRequestId());
    readReq(req)
      .then((request) => {
        const seg = request.segments;

        if (request.method === 'GET' && request.path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi = seg[0] === 'api' && seg[1] === 'v3';
        const isGraphql = request.path === '/api/graphql';
        const isMcp = request.path === '/mcp';
        const isGit = seg.length >= 2 && (seg[1] as string).endsWith('.git');

        if (isApi || isGraphql || isMcp || isGit) {
          if (!tokenOk(request)) {
            sendError(res, 401, 'Bad credentials');
            return;
          }
          if (isApi) handleRest(forge, request, res, seg.slice(2));
          else if (isGraphql) handleGraphQL(forge, request, res);
          else if (isMcp) handleMcp(forge, request, res);
          else handleGitHttp(forge, request, res, seg[0] as string, seg[1] as string, seg.slice(2));
          return;
        }

        sendError(res, 404, 'Not Found');
      })
      .catch(() => {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      });
  });
  return server;
}
