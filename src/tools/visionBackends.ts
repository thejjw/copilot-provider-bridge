// Bundled vision-agent backend catalog (pure data, no vscode/store imports so
// the catalog defaults layer can import it without module cycles).

import type { ProviderId } from '../providers';

export interface VisionBackendOption {
  id: string;
  name: string;
  providerId: ProviderId;
  description: string;
  model: string;
  endpointUrl: string;
  apiType: 'openai' | 'anthropic';
}

export const VISION_BACKENDS: VisionBackendOption[] = [
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V (Z.ai Vision)',
    providerId: 'zai',
    description: 'Z.ai internal vision model for diagram understanding and OCR.',
    model: 'glm-4.6v',
    endpointUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    apiType: 'openai',
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5V-Turbo (Z.ai Multimodal)',
    providerId: 'zai',
    description: 'Z.ai frontier multimodal coding model.',
    model: 'glm-5v-turbo',
    endpointUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    apiType: 'openai',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (Z.ai Multimodal)',
    providerId: 'zai',
    description: 'Z.ai frontier native multimodal hybrid model with 1M context.',
    model: 'glm-5.3-flash',
    endpointUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    apiType: 'openai',
  },
  /*
  // Google Gemini (Disabled for now)
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Google High-Speed Vision)',
    providerId: 'gemini',
    description: 'Google high-speed multimodal model with 1M context.',
    model: 'gemini-2.5-flash',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiType: 'openai',
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash (Google Multimodal)',
    providerId: 'gemini',
    description: 'Google latest flagship fast multimodal model.',
    model: 'gemini-3.7-flash',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiType: 'openai',
  },
  */
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    providerId: 'deepseek',
    description: 'DeepSeek multimodal model with 1M context.',
    model: 'deepseek-flash',
    endpointUrl: 'https://api.deepseek.com/anthropic/v1/messages',
    apiType: 'anthropic',
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3 (MiniMax Vision)',
    providerId: 'minimax',
    description: 'MiniMax M3 multimodal model with 1M context.',
    model: 'MiniMax-M3',
    endpointUrl: 'https://api.minimax.io/v1/chat/completions',
    apiType: 'openai',
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3 (Moonshot Vision)',
    providerId: 'kimi',
    description: 'Kimi K3 multimodal model with 1M context.',
    model: 'k3',
    endpointUrl: 'https://api.kimi.com/coding/v1/messages',
    apiType: 'anthropic',
  },
  {
    id: 'qwen3.8-max',
    name: 'Qwen 3.8 Max (Alibaba Vision)',
    providerId: 'qwen',
    description: 'Qwen 3.8 Max flagship multimodal model.',
    model: 'qwen3.8-max',
    endpointUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages',
    apiType: 'anthropic',
  },
  {
    id: 'meta/muse-glimmer-30b',
    name: 'Muse Glimmer 30B (NVIDIA NIM Vision)',
    providerId: 'nvidia',
    description: 'Meta Muse Glimmer 30B multimodal vision model on NVIDIA NIM.',
    model: 'meta/muse-glimmer-30b',
    endpointUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiType: 'openai',
  },
  {
    id: 'thinkingmachines/inkling',
    name: 'Inkling (NVIDIA NIM Vision & Reasoning)',
    providerId: 'nvidia',
    description: 'Thinking Machines Inkling multimodal model on NVIDIA NIM.',
    model: 'thinkingmachines/inkling',
    endpointUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiType: 'openai',
  },
];
