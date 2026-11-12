/*
  Order page "Past flavours", under the menu: greyed-out cards built from
  PAST_FLAVOURS in macros.js. They can't be ordered.
*/
import { PAST_FLAVOURS } from "./macros.js";

const list = document.getElementById("past-flavours-list");

if (list) {
  list.replaceChildren(...PAST_FLAVOURS.map(flavour => {

    const card = document.createElement("li");
    card.className = "flavour-card";

    if (flavour.image) {
      const img = document.createElement("img");
      img.src = flavour.image;
      img.alt = `${flavour.name} sourdough`;
      img.loading = "lazy";
      img.className = "flavour-photo";
      card.append(img);
    } else {
      const tile = document.createElement("div");
      tile.className = "flavour-photo flavour-tile";
      tile.setAttribute("aria-hidden", "true");
      tile.textContent = flavour.name;
      card.append(tile);
    }

    const name = document.createElement("h3");
    name.className = "flavour-name";
    name.textContent = flavour.name;
    card.append(name);

    if (flavour.description) {
      const text = document.createElement("p");
      text.className = "flavour-text";
      text.textContent = flavour.description;
      card.append(text);
    }

    return card;

  }));
}
