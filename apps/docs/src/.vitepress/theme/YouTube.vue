<script setup lang="ts">
// A video from the memrynote YouTube channel, for the top of the docs page it teaches.
// `start` takes a chapter stamp from the video's description ("2:08"), so a page can open on the
// part of the video that covers it. youtube-nocookie is YouTube's privacy-enhanced mode, which
// stores nothing about a reader until they play the video.
const props = defineProps<{ id: string; title: string; start?: string }>()

const seconds = (props.start ?? '0').split(':').reduce((s, part) => s * 60 + Number(part), 0)
const src = `https://www.youtube-nocookie.com/embed/${props.id}${seconds ? `?start=${seconds}` : ''}`
</script>

<template>
  <div class="youtube">
    <iframe
      :src="src"
      :title="title"
      loading="lazy"
      allow="
        accelerometer;
        autoplay;
        clipboard-write;
        encrypted-media;
        gyroscope;
        picture-in-picture;
        web-share;
      "
      referrerpolicy="strict-origin-when-cross-origin"
      allowfullscreen
    ></iframe>
  </div>
</template>

<style scoped>
.youtube {
  aspect-ratio: 16 / 9;
  margin-block: 16px 24px;
}

.youtube iframe {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 12px;
}
</style>
