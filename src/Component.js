const IO_KEY = '__IO__';

const ReactX11Component = {
  createElement(
    tag,
    props,
    rootContainerElement,
    hostContext
  ) {
    return Object.assign({[IO_KEY]: rootContainerElement}, props);
  },

  setInitialProperties(
    element,
    tag,
    rawProps,
    rootContainerElement
  ) {
    Object.assign(element, rawProps);
    //setPayloadForPin(rootContainerElement, element);
    console.log('TODO: setInitialProperties!!!', element);
  },

  diffProperties(
    element,
    tag,
    lastRawProps,
    nextRawProps,
    rootContainerElement
  ) {
    console.log('TODO: diffProperties')
  },

  updateProperties(
    element,
    updatePayload,
    type,
    oldProps,
    newProps,
    internalInstanceHandle
  ) {
    const rootContainerElement = element[IO_KEY];
    Object.assign(element, newProps);
    // setPayloadForPin(rootContainerElement, element);
    console.log('TODO: updateProperties', element);
  },
};

module.exports = ReactX11Component;
