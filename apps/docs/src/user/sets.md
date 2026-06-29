# Sets

Sets group related media around a "base" asset, typically representing variants of the same content.

## What Are Sets?

A set contains:
- A **base asset** — The primary/original media file
- **Variant items** — Derivative files in different formats, aspect ratios, or resolutions

Common use cases:
- **Responsive images**: 16:9, 4:3, 1:1 crops from a master image
- **Video transcodes**: Different resolutions and bitrates
- **Multi-format delivery**: Original CR2 raw + developed JPG + WebP variants

## Creating a Set

1. Navigate to **Sets** in the sidebar.
2. Click **Create Set**.
3. Enter a name and optional description.
4. Provide the base asset ID (the media file serving as the anchor).
5. Click **Create**.

## Managing a Set

### Adding Variants

1. From the set detail view, click **Add Variant**.
2. Search for or select a media file.
3. The file is added to the set as a variant.

### Generating Variants

::: info Planned Feature
Automated variant generation (resize, transcode, reformat) is planned for an upcoming release. For now, create variants manually by uploading derivative files and adding them to the set via **Add Variant**.
:::

### Variant Layout

The set detail page displays variants in a grid:
- Base asset at the top
- Variant items below with aspect ratio indicators (16:9, 4:3, 1:1, 9:16)
- Each variant card shows dimensions, format, and file size

### Deleting a Set

Deleting a set removes the grouping but does NOT delete the underlying media files.

## Plan Limits

<!--@include: ../shared/plan-limits.md-->
