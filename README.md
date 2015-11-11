# react-x11

WIP. Not ready yet. This is old code doing rendering by mocking React.createComponent & other code so at the moment it's just jsx + css-layout, no react. I'm working on implementation which is similar to react-blessed approach.

Communication with X Window server is done via [node-x11](https://github.com/sidorares/node-x11) (protocol implementation) and [ntk](https://github.com/sidorares/ntk) (canvas-like drawing api, higher level wrappers)

Other react renderers ( or libraries that monkey patch react to be used with non-DOM targets):

 - https://github.com/ramitos/react-tvml
 - https://github.com/Yomguithereal/react-blessed
 - https://github.com/Flipboard/react-canvas
 - https://github.com/iamdustan/react-hardware
 - https://github.com/Izzimach/react-pixi
 - https://github.com/Izzimach/react-three/
 - https://github.com/ProjectSeptemberInc/gl-react

