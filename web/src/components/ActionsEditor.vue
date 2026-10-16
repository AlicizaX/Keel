<script setup lang="ts">
import { randomUUID } from '../uuid';

interface ActionCfg {
  id: string;
  name: string;
  type: 'webhook' | 'dingtalk' | 'feishu' | 'script';
  on: 'success' | 'failure' | 'always';
  config: Record<string, any>;
}

const props = defineProps<{ modelValue: ActionCfg[] }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: ActionCfg[]): void }>();

const TYPE_LABELS: Record<string, string> = {
  webhook: 'Webhook 接口',
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
  script: '自定义脚本',
};

function add() {
  emit('update:modelValue', [
    ...props.modelValue,
    { id: randomUUID(), name: '', type: 'webhook', on: 'always', config: {} },
  ]);
}
function remove(i: number) {
  emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i));
}
function patch(i: number, p: Partial<ActionCfg>) {
  emit('update:modelValue', props.modelValue.map((a, idx) => (idx === i ? { ...a, ...p } : a)));
}
function patchCfg(i: number, key: string, v: any) {
  const a = props.modelValue[i];
  patch(i, { config: { ...a.config, [key]: v } });
}
</script>

<template>
  <div>
    <div v-for="(a, i) in modelValue" :key="a.id" class="card" style="padding:14px;margin-bottom:10px">
      <div class="row mb8">
        <select class="select" style="width:140px" :value="a.type" @change="patch(i, { type: ($event.target as HTMLSelectElement).value as any, config: {} })">
          <option v-for="(l, t) in TYPE_LABELS" :key="t" :value="t">{{ l }}</option>
        </select>
        <input class="input" style="width:160px" placeholder="动作名称（可选）" :value="a.name" @input="patch(i, { name: ($event.target as HTMLInputElement).value })" />
        <select class="select" style="width:120px" :value="a.on" @change="patch(i, { on: ($event.target as HTMLSelectElement).value as any })">
          <option value="always">总是执行</option>
          <option value="success">仅成功时</option>
          <option value="failure">仅失败时</option>
        </select>
        <span class="grow"></span>
        <button class="btn ghost danger sm" @click="remove(i)">删除</button>
      </div>

      <template v-if="a.type === 'webhook'">
        <input class="input mono" placeholder="https://example.com/hook" :value="a.config.url ?? ''" @input="patchCfg(i, 'url', ($event.target as HTMLInputElement).value)" />
        <div class="hint">构建结束后向该地址 POST JSON（event / status / build / config / project）</div>
      </template>

      <template v-else-if="a.type === 'dingtalk'">
        <div class="grid2">
          <input class="input mono" placeholder="access_token" :value="a.config.token ?? ''" @input="patchCfg(i, 'token', ($event.target as HTMLInputElement).value)" />
          <input class="input mono" placeholder="加签 secret（可选）" :value="a.config.secret ?? ''" @input="patchCfg(i, 'secret', ($event.target as HTMLInputElement).value)" />
        </div>
      </template>

      <template v-else-if="a.type === 'feishu'">
        <div class="grid2">
          <input class="input mono" placeholder="机器人 token 或完整 Hook 地址" :value="a.config.token ?? ''" @input="patchCfg(i, 'token', ($event.target as HTMLInputElement).value)" />
          <input class="input mono" placeholder="签名校验 secret（可选）" :value="a.config.secret ?? ''" @input="patchCfg(i, 'secret', ($event.target as HTMLInputElement).value)" />
        </div>
      </template>

      <template v-else-if="a.type === 'script'">
        <div class="row mb8">
          <select class="select" style="width:140px" :value="a.config.scriptType ?? 'shell'" @change="patchCfg(i, 'scriptType', ($event.target as HTMLSelectElement).value)">
            <option value="powershell">PowerShell</option>
            <option value="shell">Shell</option>
            <option value="python">Python</option>
          </select>
        </div>
        <textarea class="textarea" rows="4" spellcheck="false" placeholder="# 例如: 将产物上传到指定网站" :value="a.config.script ?? ''" @input="patchCfg(i, 'script', ($event.target as HTMLTextAreaElement).value)"></textarea>
      </template>
    </div>
    <button class="btn sm" @click="add">+ 添加后置动作</button>
  </div>
</template>
