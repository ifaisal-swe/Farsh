<script setup lang="ts">
import { Button } from 'base-ui-vue'
import { buttonVariants } from '~/lib/button'
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
defineProps<{ variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link', size?: 'default' | 'sm' | 'lg' | 'icon' }>()
</script>

<template>
  <Button type="button" data-slot="button" v-bind="$attrs" :class="cn(buttonVariants({ variant, size }), $attrs.class as string)"><slot /></Button>
</template>
