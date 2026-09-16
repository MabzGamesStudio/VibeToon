/**
 * A short corpus written for this project, so a new word database works with no
 * network and nothing downloaded. It is deliberately repetitive: a few hundred
 * words of ordinary prose about one workshop gives the extractor enough repeated
 * pairs to learn from, which a sample of scattered sentences would not.
 *
 * For a real database, add a book: the editor fetches public-domain text by URL.
 */
export const SAMPLE_CORPUS_NAME = 'Workshop sample';

export const SAMPLE_CORPUS = `
The workshop is small and the bench is long. The lamp hangs over the bench, and
the light falls on the machine. The machine is brass, and the brass is dull
where the hands have held it. The gear turns, and the gear stops, and the gear
turns again. The workshop is quiet at night.

Mabz drags the lamp over the bench. The lamp sways, and the shadow sways with
it. The shadow falls across the floor and the floor is cold. Mabz holds the
gear in one hand and the screw in the other hand. The screw is small. The gear
is heavy. The hands are careful, because the machine is old and the spring is
tired.

Tully waits by the door. The door is open, and the night is cold, and the wind
moves through the door. Tully waits, and Tully watches, and the machine does
nothing at all. The machine works when nobody watches it. That is the trick,
Mabz says, and Tully laughs at the trick.

The bulb ticks as it cools. The wire hums behind the bench. The clock on the
wall ticks, and the hour is late, and the workshop is quiet again. The lamp is
warm. The tea is cold. The cup sits on the bench beside the machine, and the
cup is empty.

Outside the workshop the garden is dark. The tree stands by the wall, and the
apple hangs on the branch, and the leaf falls slowly to the grass. The apple is
red, and the apple is sweet, and the bird takes the apple before the morning.
The rain falls on the roof, and the wind moves the branch, and the tree sways
over the garden wall.

In the house the kitchen is warm. The bread is on the table, and the knife is
beside the bread, and the honey is in the jar. The cat sits under the table,
and the cat watches the door, and the cat waits for the bird. The fire burns in
the room beyond the kitchen, and the smoke goes up the chimney into the night.

Mabz carries the lamp from the workshop to the kitchen. The light moves with
the lamp, and the shadow moves across the wall, and the room is warm. Tully
follows Mabz, and the door shuts behind them, and the workshop is dark.

The machine sits alone on the bench in the dark. The gear turns once, and the
gear turns twice, and the machine works quietly while nobody watches it. The
clock ticks. The wind moves. The bulb cools on the bench beside the brass.

In the morning the light falls through the window onto the floor. Mabz opens
the door of the workshop, and the machine is still, and the gear has stopped.
Mabz holds the machine in careful hands and says nothing. Tully brings the tea
and the bread, and they sit on the bench beside the lamp, and they wait for the
machine to forget that they are there.

The story is old. The trick is quiet. The machine is patient, and the workshop
is patient, and the night is long. The lamp burns, and the gear waits, and the
morning comes over the garden and the roof and the cold wall of the house.

Tully asks a question and Mabz does not answer. The question sits between them
like the cup on the bench. Tully asks again, slowly, and this time Mabz laughs
and shakes one careful hand at the machine. It hears us, Mabz says. It always
hears us. Tully says nothing to that, because the gear has turned again, and
because the brass is warm under the light.

Some nights the rain comes early and the garden smells of wet grass. Some
mornings the bird sings on the roof before the sun reaches the window. The cat
comes in from the cold and sits by the fire, and the fire burns low, and the
smoke climbs slowly out of the chimney above the sleeping house.

They keep a paper on the wall beside the door. The paper holds a drawing of the
machine, and the drawing is old, and the pencil lines have faded where the hands
have brushed them. Mabz draws a new line every week. Tully reads the paper every
week and says the same thing: it will work when it forgets us.

The tea goes cold twice before anybody drinks it. The bread waits on the table
under a clean cloth. The knife lies beside the bread and the honey stands in the
jar, and nobody eats, because the gear is turning and neither of them will look
away from it now.

Later the wind drops and the workshop grows still. The clock counts the hour.
The lamp swings once on its wire and settles, and the shadow settles with it,
and the brass machine turns quietly in the dark while the house sleeps around
it and the apple falls from the tree in the cold garden outside.
`.trim();
