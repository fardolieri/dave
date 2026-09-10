// The emoji the picker offers, and the check the server applies to a profile picture. Runtime-neutral: plain data only.
//
// The list is hand-curated and stops at Emoji 12.0 (2019) so nothing renders as a box on an older system;
// the picker also takes a typed or pasted emoji, so anything newer is still reachable. Names are for search.

export type EmojiEntry = { char: string; name: string };
export type EmojiCategory = { label: string; icon: string; entries: EmojiEntry[] };

/** One emoji exactly: a single RGI emoji as Unicode defines it (flags, skin tones and ZWJ families included), nothing around it. */
const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v');
export function isSingleEmoji(s: string): boolean {
  return RGI.test(s);
}

/** Longest RGI sequence is a four-person family: 7 code points, 11 UTF-16 units. A little slack for a variation selector. */
export const MAX_EMOJI_LENGTH = 16;

const parse = (lines: string): EmojiEntry[] =>
  lines.trim().split('\n').map((line) => {
    const space = line.indexOf(' ');
    return { char: line.slice(0, space), name: line.slice(space + 1).trim() };
  });

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { label: 'Smileys', icon: '😀', entries: parse(`
😀 grinning face
😃 grinning big eyes
😄 grinning smiling eyes
😁 beaming face
😆 grinning squinting laughing
😅 grinning sweat
🤣 rolling on the floor laughing
😂 tears of joy
🙂 slightly smiling
🙃 upside down
😉 winking
😊 smiling blushing
😇 halo innocent
🥰 smiling with hearts love
😍 heart eyes love
🤩 star struck
😘 blowing a kiss
😗 kissing
😚 kissing closed eyes
😙 kissing smiling eyes
😋 savoring yum
😛 tongue
😜 winking tongue
🤪 zany crazy
😝 squinting tongue
🤑 money mouth
🤗 hugging
🤭 hand over mouth
🤫 shushing quiet
🤔 thinking
🤐 zipper mouth
🤨 raised eyebrow
😐 neutral
😑 expressionless
😶 no mouth
😏 smirking
😒 unamused
🙄 rolling eyes
😬 grimacing
🤥 lying pinocchio
😌 relieved
😔 pensive
😪 sleepy
🤤 drooling
😴 sleeping zzz
😷 medical mask
🤒 thermometer sick
🤕 head bandage
🤢 nauseated
🤮 vomiting
🤧 sneezing
🥵 hot face
🥶 cold face freezing
🥴 woozy
😵 dizzy
🤯 exploding head mind blown
🤠 cowboy
🥳 partying
😎 sunglasses cool
🤓 nerd
🧐 monocle
😕 confused
😟 worried
🙁 slightly frowning
😮 open mouth
😯 hushed
😲 astonished
😳 flushed
🥺 pleading puppy eyes
😦 frowning open mouth
😧 anguished
😨 fearful
😰 anxious sweat
😥 sad relieved
😢 crying tear
😭 loudly crying sobbing
😱 screaming fear
😖 confounded
😣 persevering
😞 disappointed
😓 downcast sweat
😩 weary
😫 tired
🥱 yawning
😤 steam nose triumph
😡 pouting red angry
😠 angry
🤬 cursing swearing
😈 smiling devil horns
👿 angry devil
💀 skull
☠️ skull and crossbones
💩 pile of poo
🤡 clown
👹 ogre
👺 goblin
👻 ghost
👽 alien
👾 space invader
🤖 robot
😺 grinning cat
😸 grinning cat smiling eyes
😹 cat tears of joy
😻 heart eyes cat
😼 cat wry smile
😽 kissing cat
🙀 weary cat
😿 crying cat
😾 pouting cat
🙈 see no evil monkey
🙉 hear no evil monkey
🙊 speak no evil monkey
💋 kiss mark
💌 love letter
💘 heart with arrow
💝 heart with ribbon
💖 sparkling heart
💗 growing heart
💓 beating heart
💞 revolving hearts
💕 two hearts
💟 heart decoration
❣️ heart exclamation
💔 broken heart
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🤎 brown heart
🖤 black heart
🤍 white heart
💯 hundred points
💢 anger symbol
💥 collision boom
💫 dizzy star
💦 sweat droplets
💨 dashing away
🕳️ hole
💣 bomb
💬 speech balloon
💭 thought balloon
💤 zzz sleep
`) },
  { label: 'People', icon: '👋', entries: parse(`
👋 waving hand hello
🤚 raised back of hand
🖐️ hand with fingers splayed
✋ raised hand
🖖 vulcan salute
👌 ok hand
🤏 pinching hand
✌️ victory hand peace
🤞 crossed fingers
🤟 love you gesture
🤘 sign of the horns rock
🤙 call me hand
👈 pointing left
👉 pointing right
👆 pointing up
🖕 middle finger
👇 pointing down
☝️ index pointing up
👍 thumbs up
👎 thumbs down
✊ raised fist
👊 oncoming fist punch
🤛 left facing fist
🤜 right facing fist
👏 clapping hands
🙌 raising hands celebration
👐 open hands
🤲 palms up together
🤝 handshake
🙏 folded hands please thanks
✍️ writing hand
💅 nail polish
🤳 selfie
💪 flexed biceps strong
🦾 mechanical arm
🦵 leg
🦶 foot
👂 ear
🦻 ear with hearing aid
👃 nose
🧠 brain
🦷 tooth
🦴 bone
👀 eyes
👁️ eye
👅 tongue
👄 mouth lips
👶 baby
🧒 child
👦 boy
👧 girl
🧑 person
👱 person blond hair
👨 man
🧔 person beard
👩 woman
🧓 older person
👴 old man
👵 old woman
🙍 person frowning
🙎 person pouting
🙅 person gesturing no
🙆 person gesturing ok
💁 person tipping hand
🙋 person raising hand
🧏 deaf person
🙇 person bowing
🤦 person facepalming
🤷 person shrugging
👮 police officer
🕵️ detective
💂 guard
👷 construction worker
🤴 prince
👸 princess
👳 person wearing turban
👲 person with skullcap
🧕 woman with headscarf
🤵 person in tuxedo
👰 person with veil
🤰 pregnant woman
🤱 breast feeding
👼 baby angel
🎅 santa claus
🤶 mrs claus
🦸 superhero
🦹 supervillain
🧙 mage wizard
🧚 fairy
🧛 vampire
🧜 merperson mermaid
🧝 elf
🧞 genie
🧟 zombie
💆 person getting massage
💇 person getting haircut
🚶 person walking
🧍 person standing
🧎 person kneeling
🏃 person running
💃 woman dancing
🕺 man dancing
🕴️ person in suit levitating
👯 people with bunny ears
🧖 person in steamy room sauna
🧗 person climbing
🤺 person fencing
🏇 horse racing
⛷️ skier
🏂 snowboarder
🏌️ person golfing
🏄 person surfing
🚣 person rowing boat
🏊 person swimming
⛹️ person bouncing ball
🏋️ person lifting weights
🚴 person biking
🚵 person mountain biking
🤸 person cartwheeling
🤼 people wrestling
🤽 person playing water polo
🤾 person playing handball
🤹 person juggling
🧘 person in lotus position yoga
🛀 person taking bath
🛌 person in bed
👭 women holding hands
👫 woman and man holding hands
👬 men holding hands
💏 kiss couple
💑 couple with heart
👪 family
`) },
  { label: 'Nature', icon: '🐱', entries: parse(`
🐶 dog face
🐱 cat face
🐭 mouse face
🐹 hamster
🐰 rabbit face
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger face
🦁 lion
🐮 cow face
🐷 pig face
🐽 pig nose
🐸 frog
🐵 monkey face
🐒 monkey
🐔 chicken
🐧 penguin
🐦 bird
🐤 baby chick
🐣 hatching chick
🐥 front facing baby chick
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf
🐗 boar
🐴 horse face
🦄 unicorn
🐝 honeybee
🐛 bug caterpillar
🦋 butterfly
🐌 snail
🐞 lady beetle
🐜 ant
🦟 mosquito
🦗 cricket
🕷️ spider
🕸️ spider web
🦂 scorpion
🐢 turtle
🐍 snake
🦎 lizard
🦖 t-rex dinosaur
🦕 sauropod dinosaur
🐙 octopus
🦑 squid
🦐 shrimp
🦞 lobster
🦀 crab
🐡 blowfish
🐠 tropical fish
🐟 fish
🐬 dolphin
🐳 spouting whale
🐋 whale
🦈 shark
🐊 crocodile
🐅 tiger
🐆 leopard
🦓 zebra
🦍 gorilla
🦧 orangutan
🐘 elephant
🦛 hippopotamus
🦏 rhinoceros
🐪 camel
🐫 two hump camel
🦒 giraffe
🦘 kangaroo
🐃 water buffalo
🐂 ox
🐄 cow
🐎 horse
🐖 pig
🐏 ram
🐑 ewe sheep
🦙 llama
🐐 goat
🦌 deer
🐕 dog
🐩 poodle
🦮 guide dog
🐈 cat
🐓 rooster
🦃 turkey
🦚 peacock
🦜 parrot
🦢 swan
🦩 flamingo
🕊️ dove
🐇 rabbit
🦝 raccoon
🦨 skunk
🦡 badger
🦦 otter
🦥 sloth
🐁 mouse
🐀 rat
🐿️ chipmunk
🦔 hedgehog
🐾 paw prints
🐉 dragon
🐲 dragon face
🌵 cactus
🎄 christmas tree
🌲 evergreen tree
🌳 deciduous tree
🌴 palm tree
🌱 seedling
🌿 herb
☘️ shamrock
🍀 four leaf clover luck
🎍 pine decoration
🎋 tanabata tree
🍃 leaf fluttering in wind
🍂 fallen leaf
🍁 maple leaf
🍄 mushroom
🐚 spiral shell
🌾 sheaf of rice
💐 bouquet
🌷 tulip
🌹 rose
🥀 wilted flower
🌺 hibiscus
🌸 cherry blossom
🌼 blossom
🌻 sunflower
🌞 sun with face
🌝 full moon face
🌛 first quarter moon face
🌜 last quarter moon face
🌚 new moon face
🌕 full moon
🌖 waning gibbous moon
🌗 last quarter moon
🌘 waning crescent moon
🌑 new moon
🌒 waxing crescent moon
🌓 first quarter moon
🌔 waxing gibbous moon
🌙 crescent moon
🌎 globe americas
🌍 globe europe africa
🌏 globe asia australia
🪐 ringed planet saturn
⭐ star
🌟 glowing star
✨ sparkles
⚡ high voltage lightning
☄️ comet
🔥 fire
🌪️ tornado
🌈 rainbow
☀️ sun
🌤️ sun behind small cloud
⛅ sun behind cloud
🌥️ sun behind large cloud
☁️ cloud
🌦️ sun behind rain cloud
🌧️ cloud with rain
⛈️ cloud with lightning and rain
🌩️ cloud with lightning
🌨️ cloud with snow
❄️ snowflake
☃️ snowman
⛄ snowman without snow
🌬️ wind face
💧 droplet
☔ umbrella with rain drops
☂️ umbrella
🌊 water wave
🌫️ fog
`) },
  { label: 'Food', icon: '🍕', entries: parse(`
🍏 green apple
🍎 red apple
🍐 pear
🍊 tangerine orange
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🍈 melon
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi fruit
🍅 tomato
🍆 eggplant aubergine
🥑 avocado
🥦 broccoli
🥬 leafy green
🥒 cucumber
🌶️ hot pepper chili
🌽 ear of corn
🥕 carrot
🧄 garlic
🧅 onion
🥔 potato
🍠 roasted sweet potato
🥐 croissant
🥯 bagel
🍞 bread
🥖 baguette bread
🥨 pretzel
🧀 cheese wedge
🥚 egg
🍳 cooking fried egg
🧈 butter
🥞 pancakes
🧇 waffle
🥓 bacon
🥩 cut of meat steak
🍗 poultry leg
🍖 meat on bone
🌭 hot dog
🍔 hamburger
🍟 french fries
🍕 pizza
🥪 sandwich
🥙 stuffed flatbread
🧆 falafel
🌮 taco
🌯 burrito
🥗 green salad
🥘 shallow pan of food paella
🥫 canned food
🍝 spaghetti pasta
🍜 steaming bowl ramen noodles
🍲 pot of food stew
🍛 curry rice
🍣 sushi
🍱 bento box
🥟 dumpling
🦪 oyster
🍤 fried shrimp
🍙 rice ball
🍚 cooked rice
🍘 rice cracker
🍥 fish cake
🥠 fortune cookie
🥮 moon cake
🍢 oden
🍡 dango
🍧 shaved ice
🍨 ice cream
🍦 soft ice cream
🥧 pie
🧁 cupcake
🍰 shortcake
🎂 birthday cake
🍮 custard pudding
🍭 lollipop
🍬 candy
🍫 chocolate bar
🍿 popcorn
🍩 doughnut donut
🍪 cookie
🌰 chestnut
🥜 peanuts
🍯 honey pot
🥛 glass of milk
🍼 baby bottle
☕ hot beverage coffee
🍵 teacup tea
🧃 beverage box juice
🥤 cup with straw
🍶 sake
🍺 beer mug
🍻 clinking beer mugs cheers
🥂 clinking glasses cheers
🍷 wine glass
🥃 tumbler glass whisky
🍸 cocktail glass
🍹 tropical drink
🧉 mate
🍾 bottle with popping cork champagne
🧊 ice cube
🥄 spoon
🍴 fork and knife
🍽️ fork and knife with plate
🥣 bowl with spoon
🥡 takeout box
🥢 chopsticks
🧂 salt
`) },
  { label: 'Activities', icon: '⚽', entries: parse(`
⚽ soccer ball football
🏀 basketball
🏈 american football
⚾ baseball
🥎 softball
🎾 tennis
🏐 volleyball
🏉 rugby football
🥏 flying disc frisbee
🎱 pool 8 ball billiards
🪀 yo-yo
🏓 ping pong table tennis
🏸 badminton
🏒 ice hockey
🏑 field hockey
🥍 lacrosse
🏏 cricket game
🥅 goal net
⛳ flag in hole golf
🪁 kite
🏹 bow and arrow archery
🎣 fishing pole
🤿 diving mask
🥊 boxing glove
🥋 martial arts uniform
🎽 running shirt
🛹 skateboard
🛷 sled
⛸️ ice skate
🥌 curling stone
🎿 skis
🏆 trophy
🥇 first place medal gold
🥈 second place medal silver
🥉 third place medal bronze
🏅 sports medal
🎖️ military medal
🏵️ rosette
🎗️ reminder ribbon
🎫 ticket
🎟️ admission tickets
🎪 circus tent
🎭 performing arts theatre
🩰 ballet shoes
🎨 artist palette painting
🎬 clapper board movie
🎤 microphone singing
🎧 headphone
🎼 musical score
🎹 musical keyboard piano
🥁 drum
🎷 saxophone
🎺 trumpet
🎸 guitar
🪕 banjo
🎻 violin
🎲 game die dice
♟️ chess pawn
🎯 bullseye darts
🎳 bowling
🎮 video game controller
🕹️ joystick
🧩 puzzle piece
🎰 slot machine
🎁 wrapped gift present
🎀 ribbon
🎊 confetti ball
🎉 party popper celebration
🎈 balloon
🎏 carp streamer
🎐 wind chime
🧧 red envelope
🎃 jack-o-lantern halloween pumpkin
🎆 fireworks
🎇 sparkler
🧨 firecracker
`) },
  { label: 'Travel', icon: '🚗', entries: parse(`
🚗 automobile car
🚕 taxi
🚙 sport utility vehicle
🚌 bus
🚎 trolleybus
🏎️ racing car
🚓 police car
🚑 ambulance
🚒 fire engine
🚐 minibus
🚚 delivery truck
🚛 articulated lorry
🚜 tractor
🛴 kick scooter
🚲 bicycle
🛵 motor scooter
🏍️ motorcycle
🛺 auto rickshaw
🚨 police car light siren
🚡 aerial tramway
🚠 mountain cableway
🚃 railway car
🚋 tram car
🚄 high speed train
🚅 bullet train
🚂 locomotive steam train
🚆 train
🚇 metro subway
🚊 tram
🚉 station
✈️ airplane
🛫 airplane departure
🛬 airplane arrival
🛩️ small airplane
💺 seat
🛰️ satellite
🚀 rocket
🛸 flying saucer ufo
🚁 helicopter
🛶 canoe
⛵ sailboat
🚤 speedboat
🛥️ motor boat
🛳️ passenger ship
⛴️ ferry
🚢 ship
⚓ anchor
⛽ fuel pump
🚧 construction
🚦 vertical traffic light
🚥 horizontal traffic light
🗺️ world map
🗿 moai statue
🗽 statue of liberty
🗼 tokyo tower
🏰 castle
🏯 japanese castle
🏟️ stadium
🎡 ferris wheel
🎢 roller coaster
🎠 carousel horse
⛲ fountain
⛱️ umbrella on ground beach
🏖️ beach with umbrella
🏝️ desert island
🏜️ desert
🌋 volcano
⛰️ mountain
🏔️ snow capped mountain
🗻 mount fuji
🏕️ camping
⛺ tent
🏠 house
🏡 house with garden
🏘️ houses
🏚️ derelict house
🏗️ building construction crane
🏭 factory
🏢 office building
🏬 department store
🏣 japanese post office
🏤 post office
🏥 hospital
🏦 bank
🏨 hotel
🏪 convenience store
🏫 school
🏩 love hotel
💒 wedding
🏛️ classical building
⛪ church
🕌 mosque
🕍 synagogue
🛕 hindu temple
🕋 kaaba
⛩️ shinto shrine
🛤️ railway track
🛣️ motorway highway
🗾 map of japan
🏞️ national park
🌅 sunrise
🌄 sunrise over mountains
🌠 shooting star
🌇 sunset
🌆 cityscape at dusk
🏙️ cityscape
🌃 night with stars
🌌 milky way
🌉 bridge at night
🌁 foggy
`) },
  { label: 'Objects', icon: '💡', entries: parse(`
⌚ watch
📱 mobile phone
📲 mobile phone with arrow
💻 laptop computer
⌨️ keyboard
🖥️ desktop computer
🖨️ printer
🖱️ computer mouse
🖲️ trackball
🗜️ clamp
💽 computer disk
💾 floppy disk
💿 optical disk cd
📀 dvd
📼 videocassette vhs
📷 camera
📸 camera with flash
📹 video camera
🎥 movie camera
📽️ film projector
🎞️ film frames
📞 telephone receiver
☎️ telephone
📟 pager
📠 fax machine
📺 television tv
📻 radio
🎙️ studio microphone
🎚️ level slider
🎛️ control knobs
🧭 compass
⏱️ stopwatch
⏲️ timer clock
⏰ alarm clock
🕰️ mantelpiece clock
⌛ hourglass done
⏳ hourglass not done
📡 satellite antenna
🔋 battery
🔌 electric plug
💡 light bulb idea
🔦 flashlight torch
🕯️ candle
🪔 diya lamp
🧯 fire extinguisher
🛢️ oil drum
💸 money with wings
💵 dollar banknote
💴 yen banknote
💶 euro banknote
💷 pound banknote
💰 money bag
💳 credit card
💎 gem stone diamond
⚖️ balance scale
🧰 toolbox
🔧 wrench
🔨 hammer
⚒️ hammer and pick
🛠️ hammer and wrench
⛏️ pick
🔩 nut and bolt
⚙️ gear
🧱 brick
⛓️ chains
🧲 magnet
🔫 pistol water gun
🪓 axe
🔪 kitchen knife
🗡️ dagger
⚔️ crossed swords
🛡️ shield
🚬 cigarette
⚰️ coffin
⚱️ funeral urn
🏺 amphora
🔮 crystal ball
📿 prayer beads
🧿 nazar amulet
💈 barber pole
⚗️ alembic
🔭 telescope
🔬 microscope
🩹 adhesive bandage
🩺 stethoscope
💊 pill
💉 syringe
🩸 drop of blood
🧬 dna
🦠 microbe virus
🧫 petri dish
🧪 test tube
🌡️ thermometer
🧹 broom
🧺 basket
🧻 roll of paper toilet paper
🚽 toilet
🚰 potable water
🚿 shower
🛁 bathtub
🧼 soap
🪒 razor
🧽 sponge
🧴 lotion bottle
🛎️ bellhop bell
🔑 key
🗝️ old key
🚪 door
🪑 chair
🛋️ couch and lamp
🛏️ bed
🧸 teddy bear
🖼️ framed picture
🛍️ shopping bags
🛒 shopping cart
🎎 japanese dolls
🏮 red paper lantern
✉️ envelope
📩 envelope with arrow
📨 incoming envelope
📧 e-mail
📥 inbox tray
📤 outbox tray
📦 package
🏷️ label tag
📪 closed mailbox lowered flag
📫 closed mailbox raised flag
📬 open mailbox raised flag
📭 open mailbox lowered flag
📮 postbox
📯 postal horn
📜 scroll
📃 page with curl
📄 page facing up
📑 bookmark tabs
🧾 receipt
📊 bar chart
📈 chart increasing
📉 chart decreasing
🗒️ spiral notepad
🗓️ spiral calendar
📆 tear off calendar
📅 calendar
🗑️ wastebasket trash
📇 card index
🗃️ card file box
🗳️ ballot box
🗄️ file cabinet
📋 clipboard
📁 file folder
📂 open file folder
🗂️ card index dividers
🗞️ rolled up newspaper
📰 newspaper
📓 notebook
📔 notebook with decorative cover
📒 ledger
📕 closed book
📗 green book
📘 blue book
📙 orange book
📚 books
📖 open book
🔖 bookmark
🧷 safety pin
🔗 link
📎 paperclip
🖇️ linked paperclips
📐 triangular ruler
📏 straight ruler
🧮 abacus
📌 pushpin
📍 round pushpin location
✂️ scissors
🖊️ pen
🖋️ fountain pen
✒️ black nib
🖌️ paintbrush
🖍️ crayon
📝 memo
✏️ pencil
🔍 magnifying glass left
🔎 magnifying glass right
🔏 locked with pen
🔐 locked with key
🔒 locked
🔓 unlocked
`) },
  { label: 'Symbols', icon: '✅', entries: parse(`
✅ check mark button
☑️ check box with check
✔️ check mark
❌ cross mark
❎ cross mark button
➕ plus
➖ minus
➗ divide
✖️ multiply
♾️ infinity
💲 heavy dollar sign
💱 currency exchange
™️ trade mark
©️ copyright
®️ registered
〰️ wavy dash
➰ curly loop
➿ double curly loop
🔚 end arrow
🔙 back arrow
🔛 on arrow
🔝 top arrow
🔜 soon arrow
🔘 radio button
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
🟣 purple circle
🟤 brown circle
⚫ black circle
⚪ white circle
🟥 red square
🟧 orange square
🟨 yellow square
🟩 green square
🟦 blue square
🟪 purple square
🟫 brown square
⬛ black large square
⬜ white large square
🔶 large orange diamond
🔷 large blue diamond
🔸 small orange diamond
🔹 small blue diamond
🔺 red triangle pointed up
🔻 red triangle pointed down
💠 diamond with a dot
🔳 white square button
🔲 black square button
🔈 speaker low volume
🔇 muted speaker
🔉 speaker medium volume
🔊 speaker high volume
🔔 bell
🔕 bell with slash
📣 megaphone
📢 loudspeaker
🗯️ right anger bubble
♠️ spade suit
♣️ club suit
♥️ heart suit
♦️ diamond suit
🃏 joker
🎴 flower playing cards
🀄 mahjong red dragon
⚠️ warning
🚸 children crossing
⛔ no entry
🚫 prohibited
🚳 no bicycles
🚭 no smoking
🚯 no littering
🚱 non-potable water
🚷 no pedestrians
📵 no mobile phones
🔞 no one under eighteen
☢️ radioactive
☣️ biohazard
⬆️ up arrow
↗️ up-right arrow
➡️ right arrow
↘️ down-right arrow
⬇️ down arrow
↙️ down-left arrow
⬅️ left arrow
↖️ up-left arrow
↕️ up-down arrow
↔️ left-right arrow
↩️ right arrow curving left
↪️ left arrow curving right
⤴️ right arrow curving up
⤵️ right arrow curving down
🔃 clockwise vertical arrows
🔄 counterclockwise arrows
🛐 place of worship
⚛️ atom symbol
🕉️ om
✡️ star of david
☸️ wheel of dharma
☯️ yin yang
✝️ latin cross
☦️ orthodox cross
☪️ star and crescent
☮️ peace symbol
🕎 menorah
🔯 dotted six-pointed star
♻️ recycling symbol
⚜️ fleur-de-lis
🔱 trident emblem
📛 name badge
🔰 japanese symbol for beginner
⭕ hollow red circle
🆗 ok button
🆒 cool button
🆕 new button
🆓 free button
🆙 up button
🆖 ng button
🆘 sos button
🆔 id button
🅰️ a button blood type
🅱️ b button blood type
🆎 ab button blood type
🅾️ o button blood type
🔟 keycap ten
❗ red exclamation mark
❕ white exclamation mark
❓ red question mark
❔ white question mark
‼️ double exclamation mark
⁉️ exclamation question mark
🔅 dim button
🔆 bright button
〽️ part alternation mark
🏁 chequered flag finish
🚩 triangular flag
🎌 crossed flags
🏴 black flag
🏳️ white flag
🏳️‍🌈 rainbow flag pride
🏴‍☠️ pirate flag
`) },
];

/** Every entry, across categories; used for search and by the tests. */
export const ALL_EMOJI: EmojiEntry[] = EMOJI_CATEGORIES.flatMap((c) => c.entries);

/** Entries whose name contains the query, case-insensitive; an empty query finds nothing (the browse view shows everything). */
export function searchEmoji(query: string, entries: EmojiEntry[] = ALL_EMOJI): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return entries.filter((e) => words.every((w) => e.name.includes(w)));
}
