<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api';
import { socket } from '../ws';

const props = defineProps<{ buildId: number; active: boolean }>();

const content = ref('');
const follow = ref(true);
const copied = ref(false);
const filter = ref('');
const errorOnly = ref(false);
const el = ref<HTMLElement>();

const MAX_RENDER = 8000;
const ERR_RE = /error|exception|failed|fatal|失败|错误|异常/i;

const isErr = (l: string) => ERR_RE.test(l);

const lines = computed(() => content.value.split('\n'));

const shown = computed(() => {
  let ls = lines.value;
  if (errorOnly.value) ls = ls.filter(isErr);
  const q = filter.value.trim().toLowerCase();
  if (q) ls = ls.filter((l) => l.toLowerCase().includes(q));
  if (ls.length > MAX_RENDER) return [`... 仅显示最后 ${MAX_RENDER} 行（可下载完整日志）`, ...ls.slice(-MAX_RENDER)];
  return ls;
});

async function load() {
  const data = await api.get(`/builds/${props.buildId}/log`);
  content.value = data.content;
  scroll();
}

function scroll() {
  if (!follow.value) return;
  nextTick(() => {
    if (el.value) el.value.scrollTop = el.value.scrollHeight;
  });
}

async function copy() {
  if (!content.value) return;
  try {
    await navigator.clipboard.writeText(content.value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = content.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

function download() {
  const blob = new Blob([content.value], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `build-${props.buildId}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const onLog = (msg: { buildId: number; chunk: string }) => {
  if (msg.buildId !== props.buildId) return;
  content.value += msg.chunk;
  if (content.value.length > 2_000_000) content.value = content.value.slice(-1_000_000);
  scroll();
};

watch(() => props.buildId, load);
watch([filter, errorOnly], scroll);
onMounted(() => {
  load();
  socket.on('build:log', onLog);
});
onUnmounted(() => socket.off('build:log', onLog));
</script>

<template>
  <div>
    <div class="row between mb8">
      <span class="row" style="gap:10px">
        <span class="faint" style="font-size:12px">构建日志</span>
        <input class="input" style="width:180px;padding:4px 10px;font-size:12px" v-model="filter" placeholder="过滤关键字" />
        <label class="row" style="gap:5px;font-size:12px;color:var(--text-dim);cursor:pointer">
          <input type="checkbox" v-model="errorOnly" /> 仅看错误
        </label>
      </span>
      <span class="row" style="gap:12px">
        <label class="row" style="gap:5px;font-size:12px;color:var(--text-dim);cursor:pointer">
          <input type="checkbox" v-model="follow" /> 自动滚动
        </label>
        <button class="btn sm ghost" :disabled="!content" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
        <button class="btn sm ghost" :disabled="!content" @click="download">下载</button>
      </span>
    </div>
    <div ref="el" class="console" style="height:480px">
      <div v-for="(l, i) in shown" :key="i" class="line" :class="{ err: isErr(l) }">{{ l || ' ' }}</div>
    </div>
  </div>
</template>

<style scoped>
.line {
  min-height: 1.7em;
}
.line.err {
  color: var(--red);
}
</style>
