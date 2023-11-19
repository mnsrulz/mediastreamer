export interface StreamUrlModel { streamUrl: string; headers: Record<string, string>; speedRank: number; docId: string; status: 'HEALTHY' | 'UNHEALTHY'; }
