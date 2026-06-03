---
name: VPS Sync
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#ccc3d8'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#958da1'
  outline-variant: '#4a4455'
  surface-tint: '#d2bbff'
  primary: '#d2bbff'
  on-primary: '#3f008e'
  primary-container: '#7c3aed'
  on-primary-container: '#ede0ff'
  inverse-primary: '#732ee4'
  secondary: '#adc6ff'
  on-secondary: '#002e6a'
  secondary-container: '#0566d9'
  on-secondary-container: '#e6ecff'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#007650'
  on-tertiary-container: '#76ffc2'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#eaddff'
  primary-fixed-dim: '#d2bbff'
  on-primary-fixed: '#25005a'
  on-primary-fixed-variant: '#5a00c6'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#adc6ff'
  on-secondary-fixed: '#001a42'
  on-secondary-fixed-variant: '#004395'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 20px
  sidebar-width: 260px
---

## Brand & Style

The brand identity is centered on technical reliability and effortless synchronization. This design system adopts a **Corporate / Modern** aesthetic heavily influenced by Material Design 3, optimized for a high-performance Windows desktop environment. The personality is professional, precise, and sophisticated, aiming to provide a low-friction experience for managing complex server environments.

The visual language uses deep tonal layers to reduce eye strain, prioritizing content clarity through purposeful motion and a refined dark-mode palette. The emotional goal is to evoke a sense of security and control, making the invisible process of data synchronization feel tangible and stable.

## Colors

This design system utilizes a sophisticated dark-mode palette designed for depth and hierarchy. 

- **Primary (#7C3AED):** A soft, vibrant purple used for core actions, active states, and focus indicators.
- **Secondary (#3B82F6):** A professional blue dedicated to "Syncing" statuses and informational callouts.
- **Tertiary (#10B981):** A crisp green reserved for "Synced" success states and positive health indicators.
- **Neutral / Surface:** The foundation is built on `#121212` (Background), with layered elevations scaling through a series of deep grays to create clear visual separation between the navigation sidebar, main content area, and floating cards.
- **Error:** Use a high-visibility coral-red (#EF4444) for connection failures or sync conflicts.

## Typography

The typography system relies on **Inter** for its exceptional legibility and modern, neutral tone. To emphasize the technical nature of VPS management, **JetBrains Mono** is introduced as a secondary font for labels, IP addresses, and path strings, providing a clear distinction between UI controls and system data.

Hierarchy is established through weight and optical sizing. Headlines use tighter letter spacing for a compact, "desktop-app" feel. Body text maintains standard spacing for comfort. Labels use a slightly heavier weight to ensure visibility against dark backgrounds.

## Layout & Spacing

This design system uses a **Fixed-Fluid Hybrid** grid. The navigation sidebar is fixed at 260px, while the main content area utilizes a fluid grid that expands to fill the remaining window space. 

Content is organized into a modular card-based layout.
- **Internal Padding:** Cards use a consistent 20px (lg) padding for content.
- **Vertical Rhythm:** Elements within sections are spaced using a 4px baseline grid, typically in increments of 8px or 16px.
- **Margins:** Main containers maintain a 32px (xl) margin from the window edges to provide "breathing room" in high-density data views.

## Elevation & Depth

Depth is communicated through **Tonal Layering** and **Ambient Shadows**, consistent with Material Design 3 principles.

- **Level 0 (Base):** The darkest gray (#121212), used for the application background.
- **Level 1 (Sidebar/Surface):** A slightly lighter gray (#1E1E1E) to distinguish the navigation area.
- **Level 2 (Cards/Modules):** Elevated surfaces (#252525) that house specific server sync details.
- **Level 3 (Modals/Popovers):** The lightest surface (#2C2C2C) with a soft, 15% opacity black shadow (24px blur, 8px offset) to indicate temporary prominence.

Avoid harsh white borders; instead, use a 1px "inner stroke" at 10% opacity white to define the edges of cards against the dark background.

## Shapes

The shape language is modern and approachable. 
- **Standard Elements:** Buttons, input fields, and small UI components use a 8px (rounded-md) radius.
- **Containers:** Main cards and modals utilize a larger 16px (rounded-xl) radius to create a soft, friendly structure.
- **Indicators:** Status badges (Syncing, Paused) use a full pill-shape (999px) to differentiate them from interactive buttons.

## Components

### Buttons
- **Primary:** Solid purple (#7C3AED) with white text. High emphasis.
- **Secondary:** Outlined with a 1px border of the primary color. Medium emphasis.
- **Ghost:** No background/border, purple text. Used for low-priority sidebar items or secondary actions.

### Status Badges
Badges consist of a subtle tinted background (15% opacity) and a high-contrast label and dot.
- **Synced:** Green (#10B981) background/text with a solid dot.
- **Syncing:** Blue (#3B82F6) background/text with an animated pulsing dot.
- **Paused:** Gray (#9CA3AF) background/text with a square "stop" icon.

### Cards
Cards are the primary container for VPS instances. They should feature a 1px subtle top-highlight to mimic Windows mica/acrylic effects. They include a header for the server name, a sub-header for the IP/Status, and a footer for action buttons.

### Input Fields
Filled style with a dark gray background (#1E1E1E). On focus, the bottom border animates to the primary purple and the label shrinks above the input (Material 3 style).

### Navigation
Vertical navigation items use a highlight indicator (a vertical pill) on the left side to mark the active state, with the primary color applied to the icon and text.