export interface GPUCapabilities {
  supported: boolean;
  reason?: string;
  adapterInfo?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    backend: string;
  };
  limits?: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxComputeWorkgroupStorageSize: number;
  };
  estimatedVRAM: number;
  recommendedModel: string;
  allModels: ModelTier[];
}

export interface ModelTier {
  id: string;
  label: string;
  vramMB: number;
  downloadMB: number;
  fits: boolean;
  codeCapable: boolean;
}

const MODEL_TIERS: ModelTier[] = [
  {
    id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 Coder 0.5B',
    vramMB: 945,
    downloadMB: 400,
    fits: false,
    codeCapable: true,
  },
  {
    id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 Coder 1.5B',
    vramMB: 1630,
    downloadMB: 850,
    fits: false,
    codeCapable: true,
  },
  {
    id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 Coder 3B',
    vramMB: 2505,
    downloadMB: 1600,
    fits: false,
    codeCapable: true,
  },
  {
    id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
    label: 'Qwen 2.5 Coder 7B',
    vramMB: 5107,
    downloadMB: 4000,
    fits: false,
    codeCapable: true,
  },
];

// Known GPU VRAM sizes by description substring (vendor-reported strings).
// WebGPU doesn't expose total VRAM directly, so we match the adapter
// description against known hardware.
const KNOWN_GPUS: Array<{ pattern: RegExp; vramMB: number }> = [
  // NVIDIA
  { pattern: /RTX\s*4090/i, vramMB: 24576 },
  { pattern: /RTX\s*4080/i, vramMB: 16384 },
  { pattern: /RTX\s*4070\s*Ti\s*Super/i, vramMB: 16384 },
  { pattern: /RTX\s*4070\s*Ti/i, vramMB: 12288 },
  { pattern: /RTX\s*4070\s*Super/i, vramMB: 12288 },
  { pattern: /RTX\s*4070/i, vramMB: 12288 },
  { pattern: /RTX\s*4060\s*Ti/i, vramMB: 8192 },
  { pattern: /RTX\s*4060/i, vramMB: 8192 },
  { pattern: /RTX\s*3090/i, vramMB: 24576 },
  { pattern: /RTX\s*3080\s*Ti/i, vramMB: 12288 },
  { pattern: /RTX\s*3080/i, vramMB: 10240 },
  { pattern: /RTX\s*3070\s*Ti/i, vramMB: 8192 },
  { pattern: /RTX\s*3070/i, vramMB: 8192 },
  { pattern: /RTX\s*3060\s*Ti/i, vramMB: 8192 },
  { pattern: /RTX\s*3060/i, vramMB: 12288 },
  { pattern: /RTX\s*3050/i, vramMB: 8192 },
  { pattern: /RTX\s*2080\s*Ti/i, vramMB: 11264 },
  { pattern: /RTX\s*2080\s*Super/i, vramMB: 8192 },
  { pattern: /RTX\s*2080/i, vramMB: 8192 },
  { pattern: /RTX\s*2070/i, vramMB: 8192 },
  { pattern: /RTX\s*2060/i, vramMB: 6144 },
  { pattern: /GTX\s*1660/i, vramMB: 6144 },
  { pattern: /GTX\s*1650/i, vramMB: 4096 },
  { pattern: /GTX\s*1080\s*Ti/i, vramMB: 11264 },
  { pattern: /GTX\s*1080/i, vramMB: 8192 },
  { pattern: /GTX\s*1070/i, vramMB: 8192 },
  { pattern: /GTX\s*1060/i, vramMB: 6144 },
  { pattern: /GTX\s*1050\s*Ti/i, vramMB: 4096 },
  { pattern: /GTX\s*1050/i, vramMB: 2048 },
  { pattern: /MX\s*\d+/i, vramMB: 2048 },
  // AMD
  { pattern: /RX\s*7900\s*XTX/i, vramMB: 24576 },
  { pattern: /RX\s*7900\s*XT/i, vramMB: 20480 },
  { pattern: /RX\s*7800\s*XT/i, vramMB: 16384 },
  { pattern: /RX\s*7700\s*XT/i, vramMB: 12288 },
  { pattern: /RX\s*7600/i, vramMB: 8192 },
  { pattern: /RX\s*6900/i, vramMB: 16384 },
  { pattern: /RX\s*6800/i, vramMB: 16384 },
  { pattern: /RX\s*6700/i, vramMB: 12288 },
  { pattern: /RX\s*6600/i, vramMB: 8192 },
  { pattern: /RX\s*580/i, vramMB: 8192 },
  { pattern: /RX\s*570/i, vramMB: 4096 },
  { pattern: /RX\s*560/i, vramMB: 4096 },
  // Intel Arc
  { pattern: /Arc\s*A770/i, vramMB: 16384 },
  { pattern: /Arc\s*A750/i, vramMB: 8192 },
  { pattern: /Arc\s*A580/i, vramMB: 8192 },
  { pattern: /Arc\s*A380/i, vramMB: 6144 },
  // Intel integrated — these use shared system RAM; values are typical maximums
  { pattern: /Iris\s*Xe/i, vramMB: 4096 },
  { pattern: /UHD\s*7\d\d/i, vramMB: 4096 },
  { pattern: /UHD\s*6[2-9]\d/i, vramMB: 3900 },
  { pattern: /UHD\s*6[01]\d/i, vramMB: 3900 },
  // WebGPU often reports only architecture (e.g. "gen-9") with no device name
  { pattern: /gen-12/i, vramMB: 4096 },
  { pattern: /gen-11/i, vramMB: 3900 },
  { pattern: /gen-9/i, vramMB: 3900 },
  // Apple
  { pattern: /M4\s*Max/i, vramMB: 36864 },
  { pattern: /M4\s*Pro/i, vramMB: 24576 },
  { pattern: /M4/i, vramMB: 16384 },
  { pattern: /M3\s*Max/i, vramMB: 36864 },
  { pattern: /M3\s*Pro/i, vramMB: 18432 },
  { pattern: /M3/i, vramMB: 8192 },
  { pattern: /M2\s*Max/i, vramMB: 32768 },
  { pattern: /M2\s*Pro/i, vramMB: 16384 },
  { pattern: /M2/i, vramMB: 8192 },
  { pattern: /M1\s*Max/i, vramMB: 32768 },
  { pattern: /M1\s*Pro/i, vramMB: 16384 },
  { pattern: /M1/i, vramMB: 8192 },
];

function estimateVRAMFromGPU(description: string, maxBufferMB: number, maxStorageMB: number): number {
  // First try matching known GPUs by description
  for (const gpu of KNOWN_GPUS) {
    if (gpu.pattern.test(description)) {
      return gpu.vramMB;
    }
  }

  // Fallback: WebGPU maxBufferSize is often 256MB even on 4GB+ cards.
  // Use it as a floor, but if it's suspiciously low, estimate higher.
  const reported = Math.max(maxBufferMB, maxStorageMB);

  // If maxBufferSize is 256MB (the common cap), assume at least 2GB
  // since no dGPU with WebGPU support has less than 2GB
  if (reported <= 256 && reported > 0) {
    return 2048;
  }

  // Otherwise trust the larger of the two values
  return reported;
}

export async function detectWebGPU(): Promise<GPUCapabilities> {
  if (!navigator.gpu) {
    console.warn('[MCPRelay] navigator.gpu is undefined');
    return {
      supported: false,
      reason: 'navigator.gpu is undefined — browser does not expose WebGPU. Use Chrome 113+ or Edge 113+ and enable chrome://flags/#enable-unsafe-webgpu',
      estimatedVRAM: 0,
      recommendedModel: '',
      allModels: MODEL_TIERS,
    };
  }

  try {
    console.log('[MCPRelay] navigator.gpu exists, requesting adapter...');
    // Try high-performance first, fall back to default adapter
    let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      console.log('[MCPRelay] high-performance adapter null, trying default...');
      adapter = await navigator.gpu.requestAdapter();
    }
    if (!adapter) {
      console.warn('[MCPRelay] requestAdapter() returned null for all preferences');
      return {
        supported: false,
        reason: 'navigator.gpu exists but requestAdapter() returned null — your GPU may be blocklisted. Try chrome://flags/#enable-unsafe-webgpu or update your GPU driver.',
        estimatedVRAM: 0,
        recommendedModel: '',
        allModels: MODEL_TIERS,
      };
    }
    console.log('[MCPRelay] Got adapter:', adapter);

    // adapter.info is a property in newer Chrome; requestAdapterInfo() was removed
    const info = adapter.info ?? (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : {} as GPUAdapterInfo);
    const limits = adapter.limits;

    const maxBufferMB = Math.round((limits.maxBufferSize || 0) / (1024 * 1024));
    const maxStorageMB = Math.round((limits.maxStorageBufferBindingSize || 0) / (1024 * 1024));

    // Build a human-readable GPU description from all available fields
    const descParts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
    const fullDescription = descParts.join(' ') || 'Unknown GPU';

    const estimatedVRAM = estimateVRAMFromGPU(fullDescription, maxBufferMB, maxStorageMB);

    const models = MODEL_TIERS.map(m => ({
      ...m,
      fits: estimatedVRAM >= m.vramMB,
    }));

    const codeCapableFit = models.filter(m => m.fits && m.codeCapable);
    const anyFit = models.filter(m => m.fits);
    // Pick the largest code-capable model that fits for best demo quality
    const recommended = (codeCapableFit[codeCapableFit.length - 1] || anyFit[anyFit.length - 1])?.id || '';

    return {
      supported: true,
      adapterInfo: {
        vendor: info.vendor || 'Unknown',
        architecture: info.architecture || '',
        device: (info as any).device || '',
        description: info.description || '',
        backend: (adapter as any).info?.backend || (adapter as any).backend || '',
      },
      limits: {
        maxBufferSize: limits.maxBufferSize,
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize || 0,
      },
      estimatedVRAM,
      recommendedModel: recommended,
      allModels: models,
    };
  } catch (err) {
    return {
      supported: false,
      reason: `WebGPU error: ${err instanceof Error ? err.message : String(err)}`,
      estimatedVRAM: 0,
      recommendedModel: '',
      allModels: MODEL_TIERS,
    };
  }
}

export interface HFModelInfo {
  modelId: string;
  vramMB: number;
  isPrebuilt: boolean;
}

export async function lookupHFModel(modelIdOrUrl: string): Promise<HFModelInfo | null> {
  // Normalize: strip HF URL prefix if pasted
  let modelId = modelIdOrUrl.trim();
  modelId = modelId.replace(/^https?:\/\/huggingface\.co\//, '');
  modelId = modelId.replace(/\/$/, '');

  // Check if it's in the WebLLM prebuilt catalog
  try {
    const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    if (prebuiltAppConfig?.model_list) {
      const match = prebuiltAppConfig.model_list.find(
        (m: any) => m.model_id === modelId || m.model_id.toLowerCase() === modelId.toLowerCase()
      );
      if (match) {
        return {
          modelId: match.model_id,
          vramMB: match.vram_required_MB || 0,
          isPrebuilt: true,
        };
      }

      // Fuzzy match: user may paste a HF repo name without the -MLC suffix
      const fuzzy = prebuiltAppConfig.model_list.find(
        (m: any) => m.model_id.toLowerCase().startsWith(modelId.toLowerCase())
      );
      if (fuzzy) {
        return {
          modelId: fuzzy.model_id,
          vramMB: fuzzy.vram_required_MB || 0,
          isPrebuilt: true,
        };
      }
    }
  } catch {
    // WebLLM not loaded yet
  }

  // Not in prebuilt catalog — still might be a valid MLC model on HF
  return {
    modelId,
    vramMB: 0, // unknown
    isPrebuilt: false,
  };
}

export async function listAllPrebuiltModels(): Promise<Array<{ id: string; vramMB: number }>> {
  try {
    const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    if (prebuiltAppConfig?.model_list) {
      return prebuiltAppConfig.model_list
        .filter((m: any) => m.vram_required_MB)
        .sort((a: any, b: any) => a.vram_required_MB - b.vram_required_MB)
        .map((m: any) => ({ id: m.model_id, vramMB: m.vram_required_MB }));
    }
  } catch {
    // not loaded
  }
  return [];
}

export function checkBrowserCompat(): { webgpu: boolean; indexedDB: boolean; cacheStorage: boolean; privateMode: boolean } {
  const webgpu = !!navigator.gpu;
  let idb = false;
  let cache = false;
  let privateMode = false;

  try {
    idb = !!window.indexedDB;
    indexedDB.open('__test__').onsuccess = function() { this.result.close(); indexedDB.deleteDatabase('__test__'); };
  } catch {
    privateMode = true;
  }

  try {
    cache = !!window.caches;
  } catch {
    // Likely private browsing
  }

  return { webgpu, indexedDB: idb, cacheStorage: cache, privateMode };
}
