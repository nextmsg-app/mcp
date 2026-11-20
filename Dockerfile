# NextMsg MCP server (stdio). No dependencies: the image holds only index.js.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

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
