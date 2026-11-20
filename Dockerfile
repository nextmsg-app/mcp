# NextMsg MCP server (stdio). No dependencies: the image holds only index.js.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

LABEL org.opencontainers.image.title="NextMsg MCP server" \
      org.opencontainers.image.description="Push notifications to your phone from AI agents: a notify_human tool via the NextMsg app." \
      org.opencontainers.image.source="https://github.com/nextmsg-app/mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json index.js LICENSE ./
ENV NODE_ENV=production
USER node

# The send key comes from the NEXTMSG_KEY environment variable at run time.
ENTRYPOINT ["node", "index.js"]
