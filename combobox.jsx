var React   = require('./react-x11');
var View    = React.View;
var Text    = React.Text;
var P       = React.P;

module.exports = function() {

  this.render = function() {
  function handleClick(pt) {
    console.log('handle click!', pt);
    this.setProps({
      style: {
        color: parseInt(0.1*(pt.x - this.props.left)*(pt.y - this.props.top))
      }
    });
    console.log(this.props.style);
  }

  var p = <P onClick={ handleClick }>
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
    Lorem ipsum foo bar blah blah
  </P>

  var haha = 1;

  var pp = <View style={ { color: 0xffffff } }>
    <View style={{ color: 0xffff00 }} >A lot of flexboxes with flexWrap=wrap </View>
    <View style={{ color: 0xf0ff0f }}>{ p }</View>
  </View>

  var content = <View style={ { flexDirection: 'column', color: 0xfefefe, justifyContent: 'space-between', alignItems: 'stretch' } }>
    <View test="foo" onMousemove={ function(ev) { console.log(ev.x, ev.y); }  }>
      <Text text={ "haha " + haha }/>
    </View>
    <View foo="test" style={ { color: 0xffa0a0 } } onClick={ function() { console.log(this.props.foo); } }>
      Subview 0.1
    </View>
    <View foo="test" style={ { color: 0xa0a0a0, padding: 20, alignItems: 'stretch' } }>
      { p }
      <View foo="test" style={ { color: 0xffffff,  padding: 25 } } onMousemove={ handleClick }>
        Subview 0.2.1
      </View>
    </View>
  </View>

  //setInterval( function() {
  //  console.log('set haha to ' + haha);
  //  haha++;
  //  content.props.children[0].props.children[0].props.text = ''+ haha;
  //}, 1000);


  return content;
  }
}
