export default {
    AUTO_CLEAR_BUFFERS_INTERVAL: parseInt(process.env.AUTO_CLEAR_BUFFERS_INTERVAL_MS || '10000'),
    AUTO_CLEAR_IDLE_STREAMS_INTERVAL: parseInt(process.env.AUTO_CLEAR_IDLE_STREAMS_INTERVAL_MS || '60000'),
    maxIdleStreamTimeout: parseInt(process.env.IDLE_STREAM_TIMEOUT_MS || '3600000'), //1hour
    DEFAULT_SERVER_PORT: parseInt(process.env.PORT || '3000'),
    maxBufferSizeMB: parseInt(process.env.MAX_BUFFER_SIZE_MB || '200'),
    chunkSizeBytes: parseInt(process.env.CHUNK_SIZE_BYTES || '262144'),  //256 KB by default chunk size
    refreshInterval: parseInt(process.env.LINKS_REFRESH_INTERVAL_MS || '30000'),
    maxChunkSizeMB: parseInt(process.env.MAX_CHUNK_SIZE_MB || '8'),
    readAheadSizeMB: parseInt(process.env.READ_AHEAD_SIZE_MB || '8'),
    linksApiUrl: process.env.LINKS_API_URL || 'http://admin:admin@localhost:8000',
    rootPath: process.env.ROOT_PATH || '/'
};