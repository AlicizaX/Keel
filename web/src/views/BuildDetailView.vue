<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, fmtDuration, fmtSize, fmtTime, PHASE_LABELS } from '../api';
import { socket } from '../ws';
import StatusBadge from '../components/StatusBadge.vue';
import ProgressBar from '../components/ProgressBar.vue';
import LogConsole from '../components/LogConsole.vue';

const route = useRoute();
const router = useRouter();
const id = Number(route.params.id);

const build = ref<any>(null);
const artifacts = ref<any[]>([]);
const now = ref(Date.now());

const PHASE_ORDER = ['prepare', 'resolve', 'build', 'collect', 'actions', 'done'];

const active = computed(() => build.value && (build.value.status === 'running' || build.value.status === 'queued'));

const params = computed<{ key: string; value: string }[]>(() => {
  try {
    return JSON.parse(build.value?.params ?? '[]');
  } catch {
    return [];
  }
});

/** 阶段步骤条：合并固定阶段顺序与实际时间线，计算每步状态与耗时 */
const steps = computed(() => {
  if (!build.value) return [];
  let trail: { phase: string; at: string }[] = [];
  try {
    trail = JSON.parse(build.value.phases ?? '[]');
  } catch { /* 忽略 */ }
  const atMap = new Map(trail.map((t) => [t.phase, t.at]));
  const lastPhase = trail[trail.length - 1]?.phase;
  const b = build.value;

  return PHASE_ORDER.map((p) => {
    const at = atMap.get(p);
    let state: 'done' | 'current' | 'pending' | 'failed' | 'skipped' = 'pending';
    if (at) {
      state = 'done';
      if (p === lastPhase && b.status === 'running') state = 'current';
      if (p === lastPhase && b.status === 'failed') state = 'failed';
      if (p === lastPhase && b.status === 'canceled') state = 'failed';
    }
    const idx = trail.findIndex((t) => t.phase === p);
    let dur = '';
    if (idx >= 0 && at) {
      const next = trail[idx + 1];
      const end = next ? new Date(next.at).getTime() : b.finished_at ? new Date(b.finished_at).getTime() : now.value;
      dur = fmtMs(end - new Date(at).getTime());
    }
    return { phase: p, label: PHASE_LABELS[p] ?? p, at, state, dur };
  });
});

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function load() {
  build.value = await api.get(`/builds/${id}`);
  const all = await api.get('/artifacts');
  artifacts.value = all.filter((a: any) => a.build_id === id);
}

async function cancel() {
  try {
    await api.post(`/engine/builds/${id}/cancel`);
  } catch (e: any) {
    alert(e.message);
  }
}

async function cleanArtifact(a: any) {
  if (!confirm(`确定清理本次构建的产物？（任务记录保留，文件不可恢复）`)) return;
  try {
    await api.del(`/artifacts/${a.id}`);
    load();
  } catch (e: any) {
    alert(e.message);
  }
}

async function removeBuild() {
  if (!confirm(`确定删除构建 #${id}？将同时删除其产物、日志与残留工作区（不可恢复）`)) return;
  try {
    await api.del(`/builds/${id}`);
    router.push('/queue');
  } catch (e: any) {
    alert(e.message);
  }
}

const onUpdate = (b: any) => {
  if (b.id === id) build.value = { ...build.value, ...b };
};

let timer: number;
onMounted(() => {
  load();
  socket.on('build:update', onUpdate);
  timer = window.setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => {
  socket.off('build:update', onUpdate);
  clearInterval(timer);
});
</script>

<template>
  <div class="page" v-if="build">
    <div class="page-header">
      <div>
        <h1 class="row" style="gap:12px">
          构建 #{{ build.id }}
          <StatusBadge :status="build.status" />
        </h1>
        <div class="sub">{{ build.project_name }} · {{ build.config_name }} · {{ build.build_target }}</div>
      </div>
      <div class="row">
        <button v-if="active" class="btn danger" @click="cancel">取消构建</button>
        <button v-else class="btn ghost danger" @click="removeBuild">删除记录</button>
        <button class="btn" @click="router.push('/queue')">返回队列</button>
      </div>
    </div>

    <div class="card">
      <div class="row between mb8">
        <span class="muted" style="font-size:13px">
          {{ build.status === 'running' ? (PHASE_LABELS[build.phase] ?? build.phase) : build.status === 'queued' ? '等待调度' : '已结束' }}
        </span>
        <span class="mono faint" style="font-size:12px">{{ build.progress }}%</span>
      </div>
      <ProgressBar :value="build.progress" :status="build.status" />

      <div class="steps mt16">
        <template v-for="(s, i) in steps" :key="s.phase">
          <div class="step" :class="s.state">
            <span class="step-dot"></span>
            <span class="step-label">{{ s.label }}</span>
            <span class="step-dur mono">{{ s.dur }}</span>
          </div>
          <span v-if="i < steps.length - 1" class="step-line" :class="{ done: s.state === 'done' }"></span>
        </template>
      </div>

      <div class="row mt16" style="gap:28px;flex-wrap:wrap;font-size:13px">
        <div><span class="faint">提交：</span><span class="mono">{{ build.commit_sha ? build.commit_sha.slice(0, 12) : '-' }}</span></div>
        <div><span class="faint">Unity 版本：</span><span class="mono">{{ build.unity_version ?? '-' }}</span></div>
        <div><span class="faint">创建：</span><span class="mono muted">{{ fmtTime(build.created_at) }}</span></div>
        <div><span class="faint">总耗时：</span><span class="mono muted">{{ fmtDuration(build.started_at, build.finished_at) }}</span></div>
      </div>

      <div v-if="params.length" class="row mt16" style="gap:8px;flex-wrap:wrap">
        <span class="faint" style="font-size:12px">构建参数：</span>
        <span v-for="p in params" :key="p.key" class="tag mono">{{ p.key }}={{ p.value }}</span>
      </div>

      <div v-if="build.error" class="mt16" style="color:var(--red);font-size:13px;white-space:pre-wrap">{{ build.error }}</div>
    </div>

    <div class="card" v-if="artifacts.length">
      <div class="card-title">构建产物</div>
      <div v-for="a in artifacts" :key="a.id" class="row between" style="padding:6px 0">
        <span class="mono muted" style="font-size:12px">{{ a.path }}</span>
        <span class="row">
          <span class="faint mono" style="font-size:12px">{{ fmtSize(a.size) }}</span>
          <span v-if="a.cleaned" class="badge gray">已清理</span>
          <template v-else>
            <a class="btn sm" :href="`/api/artifacts/${a.id}/download`" download>下载</a>
            <button class="btn sm ghost danger" @click="cleanArtifact(a)">清理</button>
          </template>
        </span>
      </div>
    </div>

    <div class="card">
      <LogConsole :build-id="id" :active="active" />
    </div>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  align-items: flex-start;
  gap: 0;
  overflow-x: auto;
  padding: 4px 0 2px;
}
.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 76px;
  flex-shrink: 0;
}
.step-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
}
.step.done .step-dot { background: var(--green); }
.step.current .step-dot { background: #fafafa; animation: step-pulse 1.2s infinite; }
.step.failed .step-dot { background: var(--red); }
.step-label {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}
.step.done .step-label, .step.current .step-label { color: var(--text-dim); }
.step.failed .step-label { color: var(--red); }
.step-dur {
  font-size: 10px;
  color: var(--text-faint);
}
.step-line {
  flex: 1;
  height: 1px;
  min-width: 14px;
  margin-top: 4px;
  background: rgba(255, 255, 255, 0.1);
}
.step-line.done { background: rgba(77, 168, 121, 0.5); }
@keyframes step-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
