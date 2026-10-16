<script setup lang="ts">
interface KV { key: string; value: string }
const props = defineProps<{ modelValue: KV[]; keyPlaceholder?: string; valuePlaceholder?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: KV[]): void }>();

function update(i: number, field: 'key' | 'value', v: string) {
  const next = props.modelValue.map((kv, idx) => (idx === i ? { ...kv, [field]: v } : kv));
  emit('update:modelValue', next);
}
function add() {
  emit('update:modelValue', [...props.modelValue, { key: '', value: '' }]);
}
function remove(i: number) {
  emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i));
}
</script>

<template>
  <div>
    <div v-for="(kv, i) in modelValue" :key="i" class="kv-row">
      <input class="input mono" :placeholder="keyPlaceholder ?? '参数名'" :value="kv.key" @input="update(i, 'key', ($event.target as HTMLInputElement).value)" />
      <input class="input mono" :placeholder="valuePlaceholder ?? '参数值'" :value="kv.value" @input="update(i, 'value', ($event.target as HTMLInputElement).value)" />
      <button class="btn ghost danger sm" @click="remove(i)">删除</button>
    </div>
    <button class="btn sm" @click="add">+ 添加参数</button>
  </div>
</template>
