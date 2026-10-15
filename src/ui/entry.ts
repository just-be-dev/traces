import { Runtime } from "foldkit";
import { init, Message, Model, update, view } from "./main.ts";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
// NOTE: The just-be.dev site header, injected at /traces by its router, needs the bold weight.
import "@fontsource/ibm-plex-mono/700.css";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.run(application);
