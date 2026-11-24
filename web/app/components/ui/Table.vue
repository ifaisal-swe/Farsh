<template>
  <div data-slot="table" class="max-h-[35rem] overflow-auto">
    <table class="w-full border-collapse text-sm [&_td]:border-b [&_td]:px-2.5 [&_td]:py-3 [&_td]:text-start [&_td]:align-middle [&_th]:sticky [&_th]:top-0 [&_th]:bg-card [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-start [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground"><slot /></table>
  </div>
</template>
