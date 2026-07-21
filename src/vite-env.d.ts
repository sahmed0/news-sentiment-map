/// <reference types="vite/client" />
// d3-zoom patches selection.transition() onto the prototype at runtime; this
// type-only reference loads the d3-transition augmentation that types it, without
// adding a runtime import (d3-transition isn't a direct dependency).
/// <reference types="d3-transition" />
